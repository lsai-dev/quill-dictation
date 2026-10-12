import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { log } from './log';

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ProtocolEvent {
  event: string;
  [k: string]: unknown;
}

/**
 * A child process speaking Quill's sidecar protocol: one JSON object per line
 * on stdin/stdout, with an optional raw binary payload after a request line.
 */
export class LineProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private buffer = '';
  private pending = new Map<number, Pending>();
  private nextId = 1;
  ready: ProtocolEvent | null = null;

  constructor(readonly name: string, private bin: string, private args: string[] = []) {
    super();
  }

  get running() {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  start(timeoutMs = 15000): Promise<ProtocolEvent> {
    if (this.running && this.ready) return Promise.resolve(this.ready);
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err: Error | null, ev?: ProtocolEvent) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('event', onEvent);
        if (err) reject(err);
        else resolve(ev!);
      };
      const timer = setTimeout(() => done(new Error(`${this.name} did not start in time`)), timeoutMs);
      const onEvent = (ev: ProtocolEvent) => {
        if (ev.event === 'ready') {
          this.ready = ev;
          done(null, ev);
        }
      };
      this.on('event', onEvent);

      let child: ChildProcess;
      try {
        child = spawn(this.bin, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) {
        done(e as Error);
        return;
      }
      this.child = child;
      this.buffer = '';
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => this.onData(chunk));
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) if (line.trim()) log.debug(`[${this.name}] ${line}`);
      });
      child.stdin!.on('error', (e) => log.warn(`[${this.name}] stdin: ${e.message}`));
      child.on('error', (e) => {
        log.error(`[${this.name}] failed: ${e.message}`);
        done(e);
      });
      child.on('exit', (code, signal) => {
        log.info(`[${this.name}] exited (${code ?? signal})`);
        this.child = null;
        this.ready = null;
        const err = new Error(`${this.name} stopped unexpectedly`);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        done(new Error(`${this.name} exited during startup (${code ?? signal})`));
        this.emit('exit', code, signal);
      });
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        log.warn(`[${this.name}] non-protocol output: ${line.slice(0, 200)}`);
        continue;
      }
      if (typeof msg.event === 'string') {
        this.emit('event', msg as ProtocolEvent);
        continue;
      }
      const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || `${this.name} request failed`));
    }
  }

  request<T = any>(cmd: string, params: Record<string, unknown> = {}, payload?: Buffer, timeoutMs = 15000): Promise<T> {
    if (!this.running || !this.child?.stdin) return Promise.reject(new Error(`${this.name} is not running`));
    const id = this.nextId++;
    const header: Record<string, unknown> = { id, cmd, ...params };
    if (payload) header.bytes = payload.length;
    const line = Buffer.from(JSON.stringify(header) + '\n', 'utf8');
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: '${cmd}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // Header and payload in one write so concurrent requests can't interleave.
      this.child!.stdin!.write(payload ? Buffer.concat([line, payload]) : line);
    });
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    try {
      await this.request('shutdown', {}, undefined, 1500);
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 800);
  }
}
