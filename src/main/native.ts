import { EventEmitter } from 'node:events';
import { LineProcess, ProtocolEvent } from './lineProcess';
import { nativeBinary } from './paths';
import { log } from './log';

export interface NativeHardware {
  cpu: {
    brand: string;
    vendor: string;
    physical_cores: number;
    logical_cores: number;
    features: Record<string, boolean>;
  };
  memory: { total: number; available: number };
  gpus: {
    name: string;
    vendor_id: number;
    device_id: number;
    dedicated_vram: number;
    shared_memory: number;
    integrated: boolean;
    software?: boolean;
  }[];
}

export interface ForegroundInfo {
  handle: string | null;
  title: string | null;
  process: string | null;
}

/**
 * The Win32 helper: global hotkey (with Win+Space suppression), Escape
 * capture, keystroke injection and hardware probing. Restarted automatically
 * if it ever exits.
 */
export class NativeHelper extends EventEmitter {
  private proc: LineProcess | null = null;
  private hotkey = 'win+space';
  private hotkeyEnabled = true;
  private restarts = 0;
  available = false;
  hookError: string | null = null;

  async start(): Promise<boolean> {
    const bin = nativeBinary('quill-native');
    if (!bin) {
      log.warn('quill-native not found; using fallbacks');
      return false;
    }
    this.proc = new LineProcess('native', bin);
    this.proc.on('event', (e: ProtocolEvent) => {
      if (e.event === 'hotkey') this.emit('hotkey', e.state === 'down' ? 'down' : 'up');
      else if (e.event === 'escape') this.emit('escape');
      else if (e.event === 'hook_error') {
        this.hookError = String(e.message ?? 'Keyboard hook unavailable');
        this.emit('hook-error', this.hookError);
      }
    });
    this.proc.on('exit', () => {
      this.available = false;
      if (this.restarts++ < 5) setTimeout(() => this.start().catch(() => undefined), 500 * this.restarts);
    });
    try {
      const ready = await this.proc.start();
      this.available = true;
      log.info(`native helper ready (${ready.platform})`);
      if (ready.platform === 'windows') {
        await this.setHotkey(this.hotkey).catch((e) => log.warn(`hotkey: ${e.message}`));
        await this.setHotkeyEnabled(this.hotkeyEnabled).catch(() => undefined);
      }
      return true;
    } catch (e) {
      log.error(`native helper: ${(e as Error).message}`);
      return false;
    }
  }

  get platform(): string | null {
    return (this.proc?.ready?.platform as string) ?? null;
  }

  /** The helper can host the keyboard hook (Windows), whether or not it is installed right now. */
  get isWindowsHelper() {
    return this.available && this.platform === 'windows';
  }

  /** Global hotkeys through the helper are only available on Windows. */
  get supportsHotkey() {
    return this.available && this.platform === 'windows' && !this.hookError;
  }

  async setHotkey(spec: string) {
    this.hotkey = spec;
    if (!this.available || this.platform !== 'windows') return;
    const r = await this.proc!.request<{ hook_active?: boolean }>('set_hotkey', { hotkey: spec });
    // The helper retries a failed hook install on config changes.
    if (r.hook_active) this.hookError = null;
  }

  async setHotkeyEnabled(enabled: boolean) {
    this.hotkeyEnabled = enabled;
    if (this.available && this.platform === 'windows') await this.proc!.request('set_hotkey_enabled', { enabled });
  }

  async captureEscape(enabled: boolean) {
    if (this.supportsHotkey) await this.proc!.request('capture_escape', { enabled }).catch(() => undefined);
  }

  async paste() {
    await this.proc!.request('paste', {}, undefined, 5000);
  }

  async type(text: string) {
    await this.proc!.request('type', { text }, undefined, 30000);
  }

  async hardware(): Promise<NativeHardware | null> {
    if (!this.available) return null;
    try {
      return await this.proc!.request<NativeHardware>('hardware', {}, undefined, 8000);
    } catch (e) {
      log.warn(`hardware probe: ${(e as Error).message}`);
      return null;
    }
  }

  async vulkanAvailable(): Promise<boolean> {
    if (!this.available) return false;
    try {
      const r = await this.proc!.request<{ available: boolean }>('vulkan_available');
      return !!r.available;
    } catch {
      return false;
    }
  }

  async foreground(): Promise<ForegroundInfo | null> {
    if (!this.available) return null;
    try {
      return await this.proc!.request<ForegroundInfo>('foreground', {}, undefined, 1000);
    } catch {
      return null;
    }
  }

  async stop() {
    this.restarts = Infinity;
    await this.proc?.stop();
  }
}
