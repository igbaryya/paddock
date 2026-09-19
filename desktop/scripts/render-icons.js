/**
 * Renders the app, tray and download-site icons from SVG with Electron's own renderer, so it needs
 * nothing the package does not already install. Run it after changing an icon — `npm run icons` —
 * and commit the results; electron-builder turns build/icon.png into the .icns and build/icon-win.png
 * into the .ico.
 *
 * Every icon is the dashboard's favicon, not a copy of it. macOS draws app icons inside a margin
 * (824 of 1024 px) and expects the icon to carry its own shadow in that margin; Windows draws them
 * edge to edge, hence two renders. The full-bleed assets/icon.png is for the app's own windows.
 *
 * The download site is published as site/ alone (.github/workflows/pages.yml uploads that folder),
 * so it cannot reach the dashboard's copy and carries a rendered one instead.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app } from 'electron';

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAVICON = path.join(DESKTOP_DIR, '..', 'ui', 'public', 'favicon.svg');
const TRAY_TEMPLATE = path.join(DESKTOP_DIR, 'icons', 'tray-template.svg');
/** Relative to this package, as every output below is. */
const SITE_DIR = path.join('..', 'site');
const SITE_FAVICON = path.join(SITE_DIR, 'favicon.svg');

const NO_SHADOW = { blur: 0, offsetY: 0 };

/** Apple's icon grid: a soft shadow falling below the tile, kept inside the 100 px margin. */
const MAC_SHADOW = { blur: 20, offsetY: 10 };

const RENDERS = [
  { source: FAVICON, size: 1024, inset: 100, shadow: MAC_SHADOW, output: 'build/icon.png' },
  { source: FAVICON, size: 256, inset: 0, output: 'build/icon-win.png' },
  { source: FAVICON, size: 512, inset: 0, output: 'assets/icon.png' },
  { source: FAVICON, size: 16, inset: 0, output: 'assets/tray.png' },
  { source: FAVICON, size: 32, inset: 0, output: 'assets/tray@2x.png' },
  { source: TRAY_TEMPLATE, size: 16, inset: 0, output: 'assets/trayTemplate.png' },
  { source: TRAY_TEMPLATE, size: 32, inset: 0, output: 'assets/trayTemplate@2x.png' },
  // iOS composites a home-screen icon's transparent corners onto black, which the mark's own ground
  // already is, so it goes on full bleed and lets the system apply its mask.
  { source: FAVICON, size: 180, inset: 0, output: path.join(SITE_DIR, 'apple-touch-icon.png') },
];

/**
 * Drawn through a canvas rather than captured from the screen: the PNG keeps its alpha and is exactly
 * `size` pixels whatever the display's scale factor.
 * @param {BrowserWindow} window
 * @param {{source: string, size: number, inset: number, shadow?: {blur: number, offsetY: number}}} render
 * @returns {Promise<Buffer>}
 */
async function rasterise(window, { source, size, inset, shadow = NO_SHADOW }) {
  const svg = `data:image/svg+xml;base64,${(await fs.readFile(source)).toString('base64')}`;
  const dataUrl = await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = Object.assign(document.createElement('canvas'), { width: ${size}, height: ${size} });
        const context = Object.assign(canvas.getContext('2d'), {
          shadowColor: 'rgb(0 0 0 / 0.3)',
          shadowBlur: ${shadow.blur},
          shadowOffsetY: ${shadow.offsetY},
        });
        context.drawImage(image, ${inset}, ${inset}, ${size - 2 * inset}, ${size - 2 * inset});
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = () => reject(new Error('the SVG did not load'));
      image.src = ${JSON.stringify(svg)};
    })
  `);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false });
  await window.loadURL('about:blank');
  for (const render of RENDERS) {
    const output = path.join(DESKTOP_DIR, render.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, await rasterise(window, render));
    console.log(`${render.output}  ${render.size}×${render.size}`);
  }
  // The site draws the mark at 32 px in its header and in the tab, where the vector is the sharp one.
  await fs.copyFile(FAVICON, path.join(DESKTOP_DIR, SITE_FAVICON));
  console.log(`${SITE_FAVICON}  vector`);
}

main()
  .then(() => app.quit())
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
