/**
 * Where the Paddock server lives: the checkout around this package during development, and a copy
 * beside the app's resources once packaged. That copy is plain files, not part of the asar archive —
 * the server spawns processes with real working directories and checks real paths, and neither sees
 * into an archive.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app } from 'electron';

export const SERVER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'server')
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One of the few server modules the app shares rather than copies: its configuration, so the app
 * looks for the server where the server will listen, and its line splitter.
 * @param {string} name
 */
export const importServerModule = (name) => import(pathToFileURL(path.join(SERVER_DIR, name)).href);
