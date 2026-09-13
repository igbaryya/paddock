/**
 * Serves the built UI out of `UI_DIR`. Small on purpose — the only hard parts are the traversal
 * guard and the SPA fallback, and both are security- or correctness-critical rather than fiddly.
 *
 * The guard runs in a fixed order (null byte → decode → posix normalise → force-relative → resolve
 * → realpath). Forcing the path relative is what defeats `..` in the URL; the realpath check is
 * what defeats a symlink planted inside the build output, which is otherwise served with a 200.
 *
 * The fallback to `index.html` is gated on the extension being unknown, so a missing `/nope.js`
 * 404s instead of returning HTML under a JavaScript content type, while a client-side route like
 * `/reports/v1.2` still reaches the shell.
 */
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { UI_DIR } from '../config.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};

const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>paddock — UI not built</title>
    <style>
      body { margin: 0; display: grid; place-items: center; min-height: 100vh; color: #e6e8ec;
             font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; background: #14161a; }
      main { max-width: 34rem; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
      p { margin: 0 0 0.75rem; color: #a4abb8; }
      code { background: #1e222a; border-radius: 4px; padding: 0.15rem 0.4rem; color: #e6e8ec; }
    </style>
  </head>
  <body>
    <main>
      <h1>The dashboard has not been built yet</h1>
      <p>The API and the MCP endpoint are already running — only the static UI is missing.</p>
      <p>Build it once with <code>npm run build</code>, then reload this page.</p>
      <p>While working on the UI itself, <code>npm run dev</code> serves it from Vite with
         hot reload and proxies <code>/api</code> back to this server.</p>
    </main>
  </body>
</html>
`;

let cachedRoot = null;

/** A rebuild replaces files in place, so a resolved root keeps; a miss retries on every request. */
async function uiRoot() {
  if (cachedRoot) return cachedRoot;
  try {
    cachedRoot = await realpath(UI_DIR);
  } catch {
    return null;
  }
  return cachedRoot;
}

/** @returns {Promise<string|null>} the real path of an existing file inside `root`, else null */
async function resolveInsideRoot(root, pathname) {
  if (pathname.includes('\0')) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  // `new URL().pathname` collapses `%2e%2e` but leaves `%2f` encoded — re-normalise after decoding.
  const normalized = path.posix.normalize(decoded);
  if (!normalized.startsWith('/')) return null;

  const candidate = path.resolve(root, `.${normalized}`);
  let real;
  try {
    real = await realpath(candidate);
  } catch {
    return null;
  }
  return real === root || real.startsWith(root + path.sep) ? real : null;
}

const statFile = (file) =>
  stat(file).then((stats) => (stats.isFile() ? stats : null), () => null);

/**
 * @returns {Promise<{file:string, stats:import('node:fs').Stats}|null>} the file to serve for this
 * URL path, including the `index.html` of a directory URL, or null when nothing matches.
 */
async function resolveTarget(root, pathname) {
  const direct = await resolveInsideRoot(root, pathname);
  const stats = direct ? await statFile(direct) : null;
  if (stats) return { file: direct, stats };

  if (!pathname.endsWith('/')) return null;
  const index = await resolveInsideRoot(root, `${pathname}index.html`);
  const indexStats = index ? await statFile(index) : null;
  return indexStats ? { file: index, stats: indexStats } : null;
}

/** Vite content-hashes its assets; the shell must always be revalidated. */
const cacheControl = (file) =>
  path.extname(file).toLowerCase() === '.html' ? 'no-cache' : 'public, max-age=3600';

function sendFile(req, res, file, stats) {
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stats.size,
    'Cache-Control': cacheControl(file),
    'Last-Modified': stats.mtime.toUTCString(),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  // `pipe` tears down neither half on failure: a read error would send a short body under a
  // Content-Length we already promised, and a client that disconnects mid-download would leak the
  // file descriptor. `pipeline` destroys both directions in either case.
  pipeline(createReadStream(file), res, (err) => {
    if (err) res.destroy();
  });
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function sendStatus(res, status, headers = {}) {
  res.writeHead(status, { 'Content-Length': 0, ...headers });
  res.end();
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @returns {Promise<boolean>} true when the request was handled
 */
export async function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendStatus(res, 405, { Allow: 'GET, HEAD' });
    return true;
  }

  const root = await uiRoot();
  if (!root) {
    sendHtml(res, 200, NOT_BUILT_PAGE);
    return true;
  }

  const target = await resolveTarget(root, url.pathname);
  if (target) {
    sendFile(req, res, target.file, target.stats);
    return true;
  }

  // The extension test uses the path as asked, not a synthesised index.html, so a client route
  // with a trailing slash (`/reports/`) still reaches the shell instead of 404ing as a missing
  // `.html` asset.
  if (MIME_TYPES[path.extname(url.pathname).toLowerCase()]) {
    sendStatus(res, 404);
    return true;
  }

  const shell = await resolveTarget(root, '/');
  if (!shell) {
    sendHtml(res, 200, NOT_BUILT_PAGE);
    return true;
  }
  sendFile(req, res, shell.file, shell.stats);
  return true;
}
