import { EventEmitter } from 'node:events';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, Settings } from '../shared/types';
import { userDir } from './paths';
import { log } from './log';

/** Settings persisted as JSON in the user-data folder, written atomically. */
export class SettingsStore extends EventEmitter {
  private data: Settings;
  private file = userDir('settings.json');

  constructor() {
    super();
    this.data = { ...DEFAULT_SETTINGS };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      this.data = sanitize({ ...DEFAULT_SETTINGS, ...raw });
    } catch {
      /* first launch */
    }
  }

  get(): Settings {
    return { ...this.data };
  }

  update(patch: Partial<Settings>): Settings {
    const prev = this.data;
    this.data = sanitize({ ...this.data, ...patch });
    this.save();
    this.emit('change', this.get(), prev);
    return this.get();
  }

  private save() {
    try {
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.file);
    } catch (e) {
      log.error(`settings: ${(e as Error).message}`);
    }
  }
}

function sanitize(s: Settings): Settings {
  const pick = <T extends string>(v: string, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
  return {
    ...s,
    hotkey: typeof s.hotkey === 'string' && s.hotkey ? s.hotkey.toLowerCase() : DEFAULT_SETTINGS.hotkey,
    hotkeyMode: pick(s.hotkeyMode, ['auto', 'toggle', 'hold'] as const, 'auto'),
    engine: pick(s.engine, ['auto', 'gpu', 'cpu'] as const, 'auto'),
    motion: pick(s.motion, ['system', 'reduced', 'full'] as const, 'system'),
    insertMethod: pick(s.insertMethod, ['paste', 'type'] as const, 'paste'),
    customVocabulary: String(s.customVocabulary ?? '').slice(0, 600),
  };
}
