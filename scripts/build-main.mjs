// Bundles the Electron main process and preload scripts with esbuild.
import { build } from 'esbuild';

const watch = process.argv.some((a) => a.startsWith('--watch'));
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  external: ['electron'],
  logLevel: 'info',
};

await Promise.all([
  build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js' }),
  build({ ...common, entryPoints: ['src/preload/overlay.ts'], outfile: 'dist/preload/overlay.js' }),
  build({ ...common, entryPoints: ['src/preload/app.ts'], outfile: 'dist/preload/app.js' }),
]);
