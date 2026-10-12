import { globalShortcut } from 'electron';
import { EventEmitter } from 'node:events';
import type { NativeHelper } from './native';
import { log } from './log';

/**
 * Global shortcut source. On Windows the native helper's low-level hook gives
 * us real key-down/key-up (so hold-to-talk works) and keeps Win+Space from
 * reaching Windows. Elsewhere — or if the hook is unavailable — Electron's
 * globalShortcut provides a press-to-toggle fallback.
 */
export class Hotkey extends EventEmitter {
  private fallbackAccel: string | null = null;
  usingNative = false;
  error: string | null = null;

  constructor(private native: NativeHelper | null) {
    super();
    native?.on('hotkey', (s: 'down' | 'up') => this.emit(s));
    native?.on('escape', () => this.emit('escape'));
    native?.on('hook-error', (msg: string) => {
      this.error = msg;
      this.usingNative = false;
      this.registerFallback(this.spec);
    });
  }

  private spec = 'win+space';

  async apply(spec: string) {
    this.spec = spec;
    this.error = null;
    if (this.native?.supportsHotkey) {
      try {
        await this.native.setHotkey(spec);
        this.usingNative = true;
        this.unregisterFallback();
        return;
      } catch (e) {
        log.warn(`native hotkey: ${(e as Error).message}`);
      }
    }
    this.usingNative = false;
    this.registerFallback(spec);
  }

  async setEnabled(enabled: boolean) {
    if (this.usingNative) await this.native!.setHotkeyEnabled(enabled).catch(() => undefined);
    else if (!enabled) this.unregisterFallback();
    else this.registerFallback(this.spec);
  }

  captureEscape(on: boolean) {
    if (this.usingNative) void this.native!.captureEscape(on);
  }

  private registerFallback(spec: string) {
    this.unregisterFallback();
    const candidates = [toAccelerator(spec), 'Alt+Space', 'CommandOrControl+Shift+Space'];
    for (const accel of candidates) {
      try {
        if (globalShortcut.register(accel, () => {
          // No key-up information here: behave as a tap (toggle).
          this.emit('down');
          setTimeout(() => this.emit('up'), 0);
        })) {
          this.fallbackAccel = accel;
          if (accel !== candidates[0]) this.error = `${label(spec)} isn’t available here, so Quill is using ${accel.replace('CommandOrControl', 'Ctrl')}.`;
          log.info(`hotkey fallback registered: ${accel}`);
          return;
        }
      } catch {
        /* invalid accelerator on this platform — try the next */
      }
    }
    this.error = 'Quill couldn’t register a keyboard shortcut.';
  }

  private unregisterFallback() {
    if (this.fallbackAccel) globalShortcut.unregister(this.fallbackAccel);
    this.fallbackAccel = null;
  }

  get activeLabel(): string {
    if (this.usingNative) return label(this.spec);
    return this.fallbackAccel ? this.fallbackAccel.replace('CommandOrControl', 'Ctrl').replace('Super', 'Win') : label(this.spec);
  }
}

export function toAccelerator(spec: string): string {
  return spec
    .split('+')
    .map((p) => {
      const k = p.trim().toLowerCase();
      if (k === 'win') return 'Super';
      if (k === 'ctrl') return 'Control';
      if (k === 'alt') return 'Alt';
      if (k === 'shift') return 'Shift';
      if (k === 'space') return 'Space';
      return k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1);
    })
    .join('+');
}

/** "win+space" → "Win + Space" */
export function label(spec: string): string {
  return spec
    .split('+')
    .map((p) => {
      const k = p.trim();
      return k.length <= 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1);
    })
    .join(' + ');
}
