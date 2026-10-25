/**
 * The machine's addresses, for the dashboard to show beside the ports that listen on them: the
 * private one a phone on the same Wi-Fi reaches a dev server at, every interface's, and the public
 * one the internet sees.
 *
 * Local addresses are read on every call — that is one syscall, and a network switch should show
 * the moment it happens. The public address is the one figure that needs a request off the machine,
 * so it is cached and asked again only when it may have moved: after a while, on an explicit
 * refresh, or when the local addresses change — joining another network or a VPN is exactly when
 * it does.
 */
import dgram from 'dgram';
import net from 'net';
import os from 'os';
import { PUBLIC_IP_LOOKUP } from './config.js';

/**
 * Cloudflare's trace page answers with the caller's address as an `ip=` line. Dialled by its IPv4
 * literal, so the answer is the IPv4 address — the one a router forwards a port to.
 */
const PUBLIC_IP_URL = 'https://1.1.1.1/cdn-cgi/trace';

/** A public address rarely moves without the local ones moving too, and that re-asks at once. */
const PUBLIC_IP_TTL_MS = 5 * 60_000;

const PUBLIC_IP_TIMEOUT_MS = 3_000;

/** Any routable address does: the probe socket is connected, never written to. */
const ROUTE_PROBE_HOST = '1.1.1.1';
const ROUTE_PROBE_PORT = 53;

/** What the OS reports for an interface with no hardware address — a tunnel, a bridge. */
const NO_MAC = '00:00:00:00:00:00';

/** fe80::/10 — valid only on its own link, and every IPv6 interface has one, so it says nothing. */
const isLinkLocal = ({ family, address }) => family === 'IPv6' && /^fe[89ab]/i.test(address);

const ipv4First = (a, b) => Number(b.family === 'IPv4') - Number(a.family === 'IPv4');

/**
 * The interfaces worth showing: loopback and link-local addresses dropped, and an interface left
 * with nothing else dropped with them — on macOS that is most of the list (awdl0, llw0, the utun
 * pairs system services hold open). The primary interface first, then the OS's order; IPv4 first
 * within each, as the address anyone is likely to type.
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [raw]
 * @param {string|null} [primary] the address the default route leaves from
 * @returns {{name: string, mac: string|null, primary: boolean,
 *   addresses: {family: string, address: string, cidr: string|null}[]}[]}
 */
export function listInterfaces(raw = os.networkInterfaces(), primary = null) {
  const interfaces = [];
  for (const [name, entries = []] of Object.entries(raw)) {
    const usable = entries.filter((entry) => !entry.internal && !isLinkLocal(entry));
    if (!usable.length) continue;
    interfaces.push({
      name,
      mac: usable.find((entry) => entry.mac !== NO_MAC)?.mac ?? null,
      primary: usable.some((entry) => entry.address === primary),
      addresses: usable.sort(ipv4First).map(({ family, address, cidr }) => ({ family, address, cidr })),
    });
  }
  return interfaces.sort((a, b) => Number(b.primary) - Number(a.primary));
}

/**
 * The address traffic to the internet leaves from — the private address that matters on a machine
 * with several (Wi-Fi, Ethernet, Docker's bridge). Asked of the kernel's routing table by
 * connecting a UDP socket: a UDP connect picks the route and the source address and sends nothing.
 * With a full-tunnel VPN up this is the tunnel's address; the Wi-Fi one is still in the interface
 * list. Null when there is no route at all, which offline is the true answer.
 * @returns {Promise<string|null>}
 */
export function primaryAddress() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.unref();
    const finish = (address) => {
      socket.close();
      resolve(address);
    };
    socket.once('error', () => finish(null));
    socket.connect(ROUTE_PROBE_PORT, ROUTE_PROBE_HOST, () => finish(socket.address().address));
  });
}

/**
 * The address on the trace page's `ip=` line. Anything that is not an IP is null: a captive portal
 * or a proxy answering in Cloudflare's place must not become "your public address".
 * @param {string} text
 * @returns {string|null}
 */
export function parseTrace(text) {
  const address = /^ip=(.*)$/m.exec(text)?.[1].trim();
  return address && net.isIP(address) ? address : null;
}

async function lookupPublicIp() {
  try {
    const res = await fetch(PUBLIC_IP_URL, { signal: AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS) });
    return res.ok ? parseTrace(await res.text()) : null;
  } catch {
    return null;
  }
}

/** @type {{result: {address: string|null, checkedAt: string}, localKey: string, at: number}|null} */
let publicCached = null;
/** @type {{promise: Promise<{address: string|null, checkedAt: string}>, localKey: string}|null} */
let publicInFlight = null;

/** The local addresses as one string: a different one means a different network. */
const localKeyOf = (interfaces) =>
  interfaces.flatMap((entry) => entry.addresses.map((a) => a.address)).sort().join(' ');

const isFresh = (localKey) =>
  publicCached?.localKey === localKey && Date.now() - publicCached.at < PUBLIC_IP_TTL_MS;

function startLookup(localKey) {
  const promise = lookupPublicIp()
    .then((address) => {
      const result = { address, checkedAt: new Date().toISOString() };
      publicCached = { result, localKey, at: Date.now() };
      return result;
    })
    .finally(() => {
      if (publicInFlight?.promise === promise) publicInFlight = null;
    });
  publicInFlight = { promise, localKey };
  return promise;
}

/**
 * A failed lookup is cached like a successful one: offline, asking again every tick would only
 * stack timeouts, and coming back online changes the local addresses, which asks again anyway.
 * @param {string} localKey @param {boolean} force
 * @returns {Promise<{address: string|null, checkedAt: string}|null>} null when the lookup is off
 */
async function readPublicIp(localKey, force) {
  if (!PUBLIC_IP_LOOKUP) return null;
  if (!force && isFresh(localKey)) return publicCached.result;
  if (publicInFlight?.localKey === localKey) return publicInFlight.promise;
  return startLookup(localKey);
}

/**
 * One reading of the machine's network. `privateIp` is null when there is no route off the
 * machine; `publicIp` is null when the lookup is turned off, and has a null `address` when it ran
 * and got no answer — "could not reach Cloudflare" and "never asked" are different things to show.
 * @param {{force?: boolean}} [options] force asks for the public address again even when the cached
 *   one is fresh — the Refresh control, where a stale answer is the whole complaint
 * @returns {Promise<{readAt: string, hostname: string,
 *   privateIp: {address: string, interface: string|null}|null,
 *   publicIp: {address: string|null, checkedAt: string}|null,
 *   interfaces: ReturnType<typeof listInterfaces>}>}
 */
export async function read({ force = false } = {}) {
  const primary = await primaryAddress();
  const interfaces = listInterfaces(os.networkInterfaces(), primary);
  const publicIp = await readPublicIp(localKeyOf(interfaces), force);
  return {
    readAt: new Date().toISOString(),
    hostname: os.hostname(),
    privateIp: primary ? { address: primary, interface: interfaces.find((i) => i.primary)?.name ?? null } : null,
    publicIp,
    interfaces,
  };
}
