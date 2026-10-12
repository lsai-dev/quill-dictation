import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const root = resolve(__dirname, 'src/renderer');

export default defineConfig({
  root,
  base: './',
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
    rollupOptions: {
      input: {
        overlay: resolve(root, 'overlay.html'),
        app: resolve(root, 'app.html'),
      },
    },
  },
  server: { port: 5199, strictPort: true },
});
