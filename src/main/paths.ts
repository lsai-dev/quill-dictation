import { app } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const exe = process.platform === 'win32' ? '.exe' : '';

export function userDir(...parts: string[]) {
  return join(app.getPath('userData'), ...parts);
}

export function modelsDir() {
  const d = userDir('models');
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Locate a native sidecar. Packaged builds ship them in resources/bin; in
 * development we look in resources/bin (copied by `npm run build:native`) and
 * then straight in Cargo's target directory.
 */
export function nativeBinary(name: 'quill-native' | 'quill-engine-cpu' | 'quill-engine-vulkan'): string | null {
  const root = app.getAppPath();
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'bin', name + exe)]
    : [
        join(root, 'resources', 'bin', name + exe),
        // Cargo builds a single "quill-engine"; treat it as the CPU engine in dev.
        join(root, 'native', 'target', 'release', (name === 'quill-engine-cpu' ? 'quill-engine' : name) + exe),
      ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function rendererUrl(page: 'overlay' | 'app'): { url?: string; file?: string } {
  const dev = process.env.QUILL_DEV_SERVER;
  if (dev) return { url: `${dev}/${page}.html` };
  return { file: join(__dirname, '..', 'renderer', `${page}.html`) };
}

export function preloadPath(name: 'overlay' | 'app') {
  return join(__dirname, '..', 'preload', `${name}.js`);
}

export function assetPath(...parts: string[]) {
  return app.isPackaged ? join(process.resourcesPath, 'assets', ...parts) : join(app.getAppPath(), 'resources', ...parts);
}
