/**
 * Paddock's own mark, when the user has replaced it: one image, shown in the dashboard's sidebar and
 * its browser tab. The desktop app's dock, tray and window icons are rendered from
 * ui/public/favicon.svg when the app is built, and stay Paddock's.
 *
 * The image arrives as a data URL over the JSON API and leaves the same way, never as bytes served
 * from the manager's own origin — for the reason favicons.js gives: an SVG opened from there could
 * run script, one inside a data URL in an `<img>` cannot. Its type is read from its bytes, never from
 * the label the data URL carries.
 *
 * Written plainly, like the favicon cache, rather than atomically like the configuration: a torn or
 * hand-edited file reads as no logo, and what that costs is Paddock's mark until the user picks
 * theirs again.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { LOGO_FILE } from './config.js';
import { ValidationError } from './applications.js';
import { IMAGE_TYPES, sniffImageType } from './image-type.js';

/** Decoded. Every dashboard load carries it as base64, so it stays well under the 1 MiB body limit. */
export const MAX_LOGO_BYTES = 262_144;

const DATA_URL = /^data:[^,]*;base64,([A-Za-z0-9+/]+={0,2})$/;

/** @typedef {{contentType: string, updatedAt: string, data: string}} LogoEntry */

/** @param {unknown} dataUrl @returns {Buffer} */
function decode(dataUrl) {
  const match = typeof dataUrl === 'string' ? DATA_URL.exec(dataUrl) : null;
  if (!match) throw new ValidationError('dataUrl must be a base64 data: URL of an image');
  return Buffer.from(match[1], 'base64');
}

/** @param {Buffer} bytes @returns {string} the type the bytes say they are */
function assertImage(bytes) {
  if (bytes.length > MAX_LOGO_BYTES) {
    const size = Math.ceil(bytes.length / 1024);
    throw new ValidationError(`The logo must be ${MAX_LOGO_BYTES / 1024} KiB or smaller; this one is ${size} KiB`);
  }
  const contentType = sniffImageType(bytes);
  if (!contentType) throw new ValidationError('The logo must be a PNG, ICO, GIF, JPEG, WebP or SVG image');
  return contentType;
}

const isEntry = (value) =>
  IMAGE_TYPES.has(value?.contentType) && typeof value.updatedAt === 'string' && typeof value.data === 'string';

/** @param {LogoEntry} entry */
const viewOf = (entry) => ({
  contentType: entry.contentType,
  bytes: Buffer.byteLength(entry.data, 'base64'),
  updatedAt: entry.updatedAt,
  dataUrl: `data:${entry.contentType};base64,${entry.data}`,
});

/** @returns {Promise<ReturnType<typeof viewOf>|null>} null while Paddock's own mark is in use */
export async function read() {
  try {
    const entry = JSON.parse(await fs.readFile(LOGO_FILE, 'utf8'));
    return isEntry(entry) ? viewOf(entry) : null;
  } catch {
    return null; // missing, torn or hand-edited: Paddock's mark until the user picks theirs again
  }
}

/** @param {unknown} dataUrl @returns {Promise<ReturnType<typeof viewOf>>} */
export async function set(dataUrl) {
  const bytes = decode(dataUrl);
  const entry = {
    contentType: assertImage(bytes),
    updatedAt: new Date().toISOString(),
    data: bytes.toString('base64'),
  };
  await fs.mkdir(path.dirname(LOGO_FILE), { recursive: true });
  await fs.writeFile(LOGO_FILE, JSON.stringify(entry), { mode: 0o600 });
  return viewOf(entry);
}

/** Back to Paddock's mark. Clearing a logo that was never set is not an error. */
export async function clear() {
  await fs.rm(LOGO_FILE, { force: true });
}
