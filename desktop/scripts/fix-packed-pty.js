/**
 * Make node-pty's `spawn-helper` executable inside the packed server tree.
 *
 * node-pty is an N-API module and ships prebuilt binaries for every platform the app targets, so
 * the copy packed into `resources/server/node_modules` loads under Electron as it is — no rebuild
 * for Electron's ABI. What npm does not keep is the helper's executable bit, which the checkout's
 * own postinstall (scripts/fix-pty-helper.js) restores; this runs from electron-builder's
 * `afterPack` hook so the packed copy never depends on how it was copied.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Owner-executable — what node-pty's spawn-helper should be after npm extracts it. */
const EXECUTABLE = 0o755;

/**
 * Where the macOS app keeps the server: inside the bundle that `appOutDir` holds.
 * @param {import('electron-builder').AfterPackContext} context
 */
const macServerDir = (context) =>
  path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'server');

/**
 * Windows has no helper: its pty is ConPTY.
 * @param {import('electron-builder').AfterPackContext} context
 */
export default function fixPackedPty(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const prebuilds = path.join(macServerDir(context), 'node_modules', 'node-pty', 'prebuilds');
  // A packed server without node-pty would open no terminal at all: fail the build, not the user.
  if (!fs.existsSync(prebuilds)) throw new Error(`node-pty is missing from the packed server: ${prebuilds}`);
  for (const entry of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, entry, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, EXECUTABLE);
  }
}
