import { clipboard, ClipboardItem } from 'electron';
import { execFile } from 'node:child_process';
import type { NativeHelper } from './native';
import { log } from './log';

/** Snapshot every format on the clipboard (text, rich text, images, files…). */
async function save(): Promise<ClipboardItem[] | null> {
  try {
    const items = await clipboard.read();
    const copies: ClipboardItem[] = [];
    for (const item of items) {
      const entries: Record<string, Blob | string> = {};
      for (const type of item.types) {
        try {
          const payload = await item.getType(type);
          if (payload instanceof Blob || typeof payload === 'string') entries[type] = payload;
        } catch {
          /* format vanished while reading — skip it */
        }
      }
      if (Object.keys(entries).length) copies.push(new ClipboardItem(entries));
    }
    return copies;
  } catch (e) {
    log.warn(`clipboard save: ${(e as Error).message}`);
    return null;
  }
}

async function restore(items: ClipboardItem[]) {
  try {
    if (items.length) await clipboard.write(items);
    else await clipboard.clear();
  } catch (e) {
    log.warn(`clipboard restore: ${(e as Error).message}`);
  }
}

/**
 * Put text where the user's cursor is. Pasting is the most compatible route
 * (rich editors, terminals, browsers); the previous clipboard is restored a
 * moment later so dictation never costs you what you'd copied.
 */
export async function insertText(
  text: string,
  opts: { method: 'paste' | 'type'; restoreClipboard: boolean },
  native: NativeHelper | null,
): Promise<void> {
  if (!text) return;
  if (opts.method === 'type' && native?.supportsHotkey) {
    await native.type(text);
    return;
  }
  const saved = opts.restoreClipboard ? await save() : null;
  await clipboard.writeText(text);
  try {
    await sendPaste(native);
  } finally {
    if (saved) {
      setTimeout(async () => {
        // Only restore if nothing else has claimed the clipboard since.
        if ((await clipboard.readText().catch(() => '')) === text) await restore(saved);
      }, 1200);
    }
  }
}

async function sendPaste(native: NativeHelper | null) {
  if (native?.available && native.platform === 'windows') return native.paste();
  if (process.platform === 'darwin') {
    return run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
  }
  if (process.platform === 'linux') {
    return run('xdotool', ['key', '--clearmodifiers', 'ctrl+v']).catch(() => run('wtype', ['-M', 'ctrl', 'v', '-m', 'ctrl']));
  }
  throw new Error('No way to paste on this system');
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 4000 }, (err) => {
      if (err) {
        log.warn(`${cmd}: ${err.message}`);
        reject(err);
      } else resolve();
    });
  });
}
