// Renders Quill's icons from the real ribbon renderer (dev-only; needs Playwright + a running `npx vite`).
// Usage: npx vite & node scripts/render-icons.mjs
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const base = process.env.QUILL_DEV_SERVER ?? 'http://localhost:5199';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
mkdirSync('resources', { recursive: true });

async function shot(url, out, size) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.goto(`${base}${url}`);
  await page.waitForFunction(() => window.ready === true);
  await page.waitForTimeout(200);
  const buf = await page.locator('#tile').screenshot({ omitBackground: true });
  writeFileSync(out, buf);
  await page.close();
  console.log('wrote', out, size ?? '');
}
await shot('/playground/icon.html', 'resources/icon.png');

// Monochrome tray glyphs: the ribbon's silhouette, one per taskbar theme.
const glyph = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M2.4 19.6C7.4 12.4 12.6 11.8 16 15.6 12.6 18 7.6 21.4 2.4 19.6Z" fill="${fill}"/>
  <path d="M16 15.6C19.4 9.6 25 8.2 29.6 10.6 25 14.4 19.8 19 16 15.6Z" fill="${fill}" opacity=".78"/>
</svg>`;
const page = await browser.newPage();
for (const [name, fill] of [['tray-dark', '#1d1d1f'], ['tray-light', '#ffffff'], ['trayTemplate', '#000000']]) {
  for (const [suffix, px] of [['', 16], ['@2x', 32]]) {
    await page.setViewportSize({ width: px, height: px });
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${Buffer.from(glyph(fill)).toString('base64')}" width="${px}" height="${px}" style="display:block">`);
    writeFileSync(`resources/${name}${suffix}.png`, await page.screenshot({ omitBackground: true }));
  }
}
console.log('wrote tray glyphs');
await browser.close();
