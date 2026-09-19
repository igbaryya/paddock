/**
 * Restore the executable bit on node-pty's `spawn-helper`, after every install.
 *
 * node-pty ships prebuilt binaries inside its npm tarball, and npm does not preserve the
 * executable bit when it extracts them. On macOS and Linux the pty is opened by exec'ing that
 * helper, so without the bit every single `pty.spawn` fails with `posix_spawnp failed` — a message
 * that names nothing anyone could act on, from a file nobody edited.
 *
 * It runs from `postinstall` because that is the only moment the fault is introduced, and it is
 * deliberately silent and unfailing: an install must not break over an optional feature, and a
 * checkout with no node-pty (or a Windows one, which uses ConPTY and has no helper) has nothing
 * to repair.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREBUILDS = path.join(ROOT_DIR, 'node_modules', 'node-pty', 'prebuilds');

/** Owner-executable, and readable and executable by everyone — what a shipped binary should be. */
const EXECUTABLE = 0o755;

if (process.platform !== 'win32') {
  for (const entry of readDir(PREBUILDS)) {
    const helper = path.join(PREBUILDS, entry, 'spawn-helper');
    // Every platform's prebuilds are extracted, not just this machine's, and only the ones for a
    // Unix host have a helper at all.
    if (!fs.existsSync(helper)) continue;
    try {
      fs.chmodSync(helper, EXECUTABLE);
    } catch {
      // A read-only store (Nix) or a helper owned by someone else. Nothing here is worth failing
      // an install over; the terminal will report why it cannot open instead.
    }
  }
}

/** @param {string} directory @returns {string[]} its entries, or none when it is not there */
function readDir(directory) {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}
