import { net } from 'electron';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createReadStream, createWriteStream, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { modelById, modelUrl, MODELS } from '../shared/models';
import type { DownloadProgress, ModelState } from '../shared/types';
import { modelsDir } from './paths';
import { log } from './log';

/**
 * Model downloads: resumable (HTTP Range into a .partial file), verified
 * against the SHA-256 the model host publishes, and moved into place
 * atomically — a half-finished file is never mistaken for a model.
 */
export class Downloads extends EventEmitter {
  private active = new Map<string, { controller: AbortController; progress: DownloadProgress }>();

  pathFor(modelId: string): string | null {
    const m = modelById(modelId);
    return m ? join(modelsDir(), m.file) : null;
  }

  isInstalled(modelId: string): boolean {
    const p = this.pathFor(modelId);
    const m = modelById(modelId);
    if (!p || !m || !existsSync(p)) return false;
    // Guard against truncated files from older interrupted copies.
    return statSync(p).size > m.sizeBytes * 0.9;
  }

  states(): ModelState[] {
    return MODELS.map((m) => ({ id: m.id, installed: this.isInstalled(m.id), path: this.isInstalled(m.id) ? this.pathFor(m.id) : null }));
  }

  progress(): DownloadProgress[] {
    return [...this.active.values()].map((a) => a.progress);
  }

  cancel(modelId: string) {
    this.active.get(modelId)?.controller.abort();
  }

  remove(modelId: string) {
    this.cancel(modelId);
    const p = this.pathFor(modelId);
    for (const f of [p, p && p + '.partial']) {
      if (f && existsSync(f)) {
        try {
          unlinkSync(f);
        } catch (e) {
          log.warn(`remove ${f}: ${(e as Error).message}`);
        }
      }
    }
  }

  async download(modelId: string): Promise<string> {
    const m = modelById(modelId);
    if (!m) throw new Error(`Unknown model ${modelId}`);
    const dest = this.pathFor(modelId)!;
    if (this.isInstalled(modelId)) return dest;
    if (this.active.has(modelId)) throw new Error('Already downloading');

    const controller = new AbortController();
    const progress: DownloadProgress = { modelId, received: 0, total: m.sizeBytes, bytesPerSec: 0, state: 'downloading' };
    this.active.set(modelId, { controller, progress });
    const emit = () => this.emit('progress', { ...progress });
    emit();

    const partial = dest + '.partial';
    try {
      const url = modelUrl(m);
      const { sha256, size } = await this.probe(url, controller.signal);
      if (size) progress.total = size;

      let offset = existsSync(partial) ? statSync(partial).size : 0;
      if (size && offset > size) {
        unlinkSync(partial);
        offset = 0;
      }
      const res = await net.fetch(url, {
        headers: offset ? { Range: `bytes=${offset}-` } : {},
        signal: controller.signal,
      } as RequestInit);
      if (!res.ok && res.status !== 206) throw new Error(`Server responded ${res.status}`);
      if (offset && res.status !== 206) offset = 0; // server ignored the range — start over
      const total = size || (Number(res.headers.get('content-length')) + offset) || m.sizeBytes;
      progress.total = total;
      progress.received = offset;

      const out = createWriteStream(partial, { flags: offset ? 'a' : 'w' });
      const reader = res.body!.getReader();
      let windowStart = Date.now();
      let windowBytes = 0;
      let lastEmit = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        progress.received += value.byteLength;
        windowBytes += value.byteLength;
        const now = Date.now();
        if (now - windowStart >= 700) {
          const rate = (windowBytes * 1000) / (now - windowStart);
          progress.bytesPerSec = progress.bytesPerSec ? progress.bytesPerSec * 0.6 + rate * 0.4 : rate;
          windowStart = now;
          windowBytes = 0;
        }
        if (now - lastEmit > 120) {
          lastEmit = now;
          emit();
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));

      progress.state = 'verifying';
      emit();
      const actualSize = statSync(partial).size;
      if (size && actualSize !== size) throw new Error('The download was incomplete. Please try again.');
      if (sha256) {
        const digest = await sha256File(partial);
        if (digest !== sha256) {
          unlinkSync(partial);
          throw new Error('The downloaded file failed verification and was discarded. Please try again.');
        }
      }
      renameSync(partial, dest);
      progress.state = 'done';
      progress.received = progress.total;
      emit();
      log.info(`downloaded ${modelId} (${actualSize} bytes${sha256 ? ', sha256 verified' : ''})`);
      return dest;
    } catch (e) {
      const aborted = controller.signal.aborted;
      progress.state = aborted ? 'cancelled' : 'error';
      progress.error = aborted ? undefined : friendly(e as Error);
      emit();
      if (!aborted) log.error(`download ${modelId}: ${(e as Error).message}`);
      throw e;
    } finally {
      this.active.delete(modelId);
    }
  }

  /**
   * The model host answers with a redirect to its CDN; that redirect carries
   * the file's SHA-256 (`x-linked-etag`) and size (`x-linked-size`).
   */
  private probe(url: string, signal: AbortSignal): Promise<{ sha256: string | null; size: number | null }> {
    return new Promise((resolve) => {
      const none = { sha256: null, size: null };
      let done = false;
      const finish = (v: { sha256: string | null; size: number | null }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          req.abort();
        } catch {
          /* already finished */
        }
        resolve(v);
      };
      const read = (headers: Record<string, string | string[]>) => {
        const get = (k: string) => {
          const v = headers[k] ?? headers[k.toLowerCase()];
          return Array.isArray(v) ? v[0] : v ?? '';
        };
        const etag = get('x-linked-etag') || get('etag');
        return {
          sha256: etag.match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase() ?? null,
          size: Number(get('x-linked-size')) || null,
        };
      };
      const req = net.request({ url, method: 'HEAD', redirect: 'manual' });
      const timer = setTimeout(() => finish(none), 15000);
      signal.addEventListener('abort', () => finish(none));
      req.on('redirect', (_status, _method, _to, headers) => finish(read(headers)));
      req.on('response', (res) => finish(read(res.headers)));
      req.on('error', () => finish(none));
      req.end();
    });
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

function friendly(e: Error): string {
  const m = e.message || '';
  if (/ENOSPC/i.test(m)) return 'Not enough disk space for this model.';
  if (/net::|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT/i.test(m)) return 'Couldn’t reach the download server. Check your connection and try again.';
  return m;
}
