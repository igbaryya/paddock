/**
 * Where the main process's own files live: the tray images, the app icon and the splash page, all
 * rendered or written into assets/ and packed into the app's archive with the code that loads them.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');

/** The mark at full bleed: the splash screen's logo, and the window icon on Windows and Linux. */
export const APP_ICON = path.join(ASSETS_DIR, 'icon.png');
