/**
 * HTTP requests to services on this machine, and nowhere else. Favicon discovery and web detection
 * both ask a managed process's own ports what they serve; neither may be turned into a request that
 * leaves loopback, by a redirect or otherwise.
 */
const PROBE_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The only URLs a probe will fetch: a page on this machine, or an icon inlined into one. Anything
 * else is a service reaching out on the manager's behalf, which is not what a probe is for.
 */
function isAllowedUrl(url) {
  if (url.protocol === 'data:') return true;
  return url.protocol === 'http:' && (LOOPBACK_HOSTS.has(url.hostname) || url.hostname.startsWith('127.'));
}

/**
 * Stops reading the moment the body outgrows `maxBytes`: null when it did, unless `truncate` asks
 * for what fit — enough of a page to read its head, without downloading all of it.
 */
async function readBounded(body, maxBytes, truncate) {
  if (!body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) {
      if (!truncate) return null;
      chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
      break;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * GET a loopback URL. Redirects are followed by hand so every hop can be checked: `redirect:
 * 'follow'` would let a page on this machine send the request somewhere that is not.
 * @param {string} href
 * @param {number} maxBytes
 * @param {{truncate?: boolean, headers?: Record<string, string>}} [options]
 * @returns {Promise<{url: string, contentType: string, bytes: Buffer}|null>} null for any failure,
 *   a non-2xx answer included
 */
export async function fetchLocal(href, maxBytes, { truncate = false, headers } = {}) {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  let url = new URL(href);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS && isAllowedUrl(url); hop += 1) {
      const res = await fetch(url, { redirect: 'manual', signal, headers });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      const bytes = await readBounded(res.body, maxBytes, truncate);
      return bytes && { url: url.href, contentType: res.headers.get('content-type') ?? '', bytes };
    }
  } catch {
    // Refused, reset, timed out, not HTTP at all (a database on the port) — all mean "nothing here".
  }
  return null;
}

/**
 * Where to reach a listener from this machine. One listener is merged across address families, so
 * it can hold several binds; IPv4 is preferred because it is what a dual-stack server answers on
 * too. A wildcard bind is reachable on loopback. A bind to one LAN address is not, and probing it
 * would mean leaving loopback, so a listener with nothing else is skipped.
 * @param {{port: number, addresses: string[]}} listener
 * @returns {string|null} e.g. `http://127.0.0.1:5173`
 */
export function originOf({ port, addresses }) {
  if (addresses.some((address) => address === '0.0.0.0' || address.startsWith('127.'))) {
    return `http://127.0.0.1:${port}`;
  }
  if (addresses.some((address) => address === '::' || address === '::1')) return `http://[::1]:${port}`;
  return null;
}
