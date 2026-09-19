/**
 * Rebuild node-pty against Electron's ABI inside the packed server tree.
 *
 * The desktop app copies the checkout's `node_modules` verbatim into
 * `resources/server/node_modules`, and the server runs as an Electron utility process — so a
 * binding compiled for the developer's `node` ABI fails to load at runtime. This runs from
 * electron-builder's `afterPack` hook and rebuilds only inside the packed copy, leaving the
 * checkout's own build untouched for `npm start`.
 */
import { rebuild } from '@electron/rebuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Owner-executable — what node-pty's spawn-helper should be after npm extracts it. */
const EXECUTABLE = 0o755;

/**
 * Where the server lives inside a packaged app.
 * @param {import('electron-builder').AfterPackContext} context
 */
function serverDir(context) {
  return context.packager.platform.name === 'darwin'
    ? path.join(context.appOutDir, '..', 'Resources', 'server')
    : path.join(context.appOutDir, 'resources', 'server');
}

/** @param {string} ptyPath */
function fixSpawnHelper(ptyPath) {
  if (process.platform === 'win32') return;
  const prebuilds = path.join(ptyPath, 'prebuilds');
  if (!fs.existsSync(prebuilds)) return;
  for (const entry of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, entry, 'spawn-helper');
    if (!fs.existsSync(helper)) continue;
    try {
      fs.chmodSync(helper, EXECUTABLE);
    } catch {
      // A read-only store is not worth failing the whole pack over.
    }
  }
}

/**
 * @param {import('electron-builder').AfterPackContext} context
 */
export default async function rebuildNative(context) {
  const target = serverDir(context);
  const ptyPath = path.join(target, 'node_modules', 'node-pty');
  if (!fs.existsSync(ptyPath)) {
    console.error('[paddock] rebuild-native: no node-pty in packed server — skipping');
    return;
  }

  const desktopPkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8'));
  const raw = desktopPkg.devDependencies?.electron ?? '';
  const electronVersion = raw.replace(/^[^\d]*/, '');
  if (!electronVersion) {
    throw new Error('desktop/package.json has no electron devDependency version');
  }

  console.error(
    `[paddock] rebuild-native: node-pty for Electron ${electronVersion} (${context.arch}) in ${target}`
  );

  await rebuild({
    buildPath: target,
    electronVersion,
    arch: context.arch,
    onlyModules: ['node-pty'],
  });

  fixSpawnHelper(ptyPath);
}
