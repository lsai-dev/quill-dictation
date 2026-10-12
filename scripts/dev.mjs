// Development: Vite for the renderers, esbuild for main, then Electron.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = `http://localhost:${server.config.server.port}`;

await new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['scripts/build-main.mjs', '--watch-once'], { stdio: 'inherit' });
  p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('main build failed'))));
});

const electron = (await import('electron')).default;
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, QUILL_DEV_SERVER: url } });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
