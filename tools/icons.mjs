/**
 * The PWA's PNG icons, drawn from assets/icon.svg by headless Chrome, into
 * assets/pwa/. They are kept in git: run this again only when the icon changes.
 *
 *   npm run icons
 *
 * - icon-192.png, icon-512.png: the icon as it is, its rounded corners clear.
 * - icon-maskable-512.png: the launcher cuts it to its own shape, as small as a
 *   circle of 80% of the side, so the drawing shrinks into that and the
 *   background fills the whole square.
 * - apple-touch-icon.png: iOS rounds the corners itself and puts black under
 *   anything clear, so the background goes up to the edges.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch } from './chrome.mjs';
import { root } from './load.mjs';

const svg = (await readFile(join(root, 'assets', 'icon.svg'), 'utf8')).replace(/<\?xml[\s\S]*?\?>/, '').trim();
// The icon's own background, behind the maskable and the Apple icons.
const background = /<rect[^>]*\bfill="(#[0-9a-f]{3,8})"/i.exec(svg)?.[1];
if (!background) throw new Error('assets/icon.svg: no background <rect fill="#…"> found');

const ICONS = [
  { name: 'icon-192.png', size: 192, scale: 1, fill: false },
  { name: 'icon-512.png', size: 512, scale: 1, fill: false },
  { name: 'icon-maskable-512.png', size: 512, scale: 0.8, fill: true },
  { name: 'apple-touch-icon.png', size: 180, scale: 1, fill: true },
];

const browser = await launch({ width: 600, height: 600 });
if (!browser) {
  console.error('No Chrome found — set CHROME=/path/to/chrome.');
  process.exit(1);
}
const { send, until } = browser;
const outDir = join(root, 'assets', 'pwa');
await mkdir(outDir, { recursive: true });

try {
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  for (const { name, size, scale, fill } of ICONS) {
    await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
    const inner = Math.round(size * scale);
    const page = `<!doctype html><html style="overflow:hidden"><body style="margin:0;background:${fill ? background : 'transparent'}">
<div style="width:${size}px;height:${size}px;display:grid;place-items:center">
<div style="width:${inner}px;height:${inner}px">${svg.replace('<svg', '<svg width="100%" height="100%" style="display:block"')}</div>
</div></body></html>`;
    await send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(page).toString('base64')}` });
    await until(`document.readyState === 'complete'`);
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
    await writeFile(join(outDir, name), Buffer.from(data, 'base64'));
    console.log(`assets/pwa/${name} ${size}×${size}`);
  }
} finally {
  await browser.close();
}
