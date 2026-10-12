import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

let file: string | null = null;

export function initLog(dir: string) {
  try {
    mkdirSync(dir, { recursive: true });
    file = join(dir, 'quill.log');
    try {
      if (statSync(file).size > 2 * 1024 * 1024) renameSync(file, file + '.1');
    } catch {
      /* no previous log */
    }
  } catch {
    file = null;
  }
}

function write(level: string, msg: string) {
  const line = `${new Date().toISOString()} ${level} ${msg}`;
  if (level !== 'DEBUG' || process.env.QUILL_DEBUG) console.log(line);
  if (file) {
    try {
      appendFileSync(file, line + '\n');
    } catch {
      /* logging must never throw */
    }
  }
}

export const log = {
  debug: (m: string) => write('DEBUG', m),
  info: (m: string) => write('INFO', m),
  warn: (m: string) => write('WARN', m),
  error: (m: string) => write('ERROR', m),
};
