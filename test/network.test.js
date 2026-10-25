/**
 * network.js — what the sidebar's addresses and the ports page's network panel show.
 *
 * The interface filter is pinned with fixed inputs, because the failure it guards against is a list
 * that is technically right and useless: every macOS tunnel and link-local address, with the one
 * address anyone types buried among them. The public lookup is turned off for the whole file, so
 * the suite never asks the internet anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paddock-test-'));
process.env.PADDOCK_DATA_DIR = dataDir;
process.env.PADDOCK_PUBLIC_IP_LOOKUP = 'false';

const network = await import(new URL('../network.js', import.meta.url).href);

const NO_MAC = '00:00:00:00:00:00';
const v4 = (address, extra = {}) =>
  ({ family: 'IPv4', address, cidr: `${address}/24`, mac: 'aa:bb:cc:dd:ee:ff', internal: false, ...extra });
const v6 = (address, extra = {}) =>
  ({ family: 'IPv6', address, cidr: `${address}/64`, mac: 'aa:bb:cc:dd:ee:ff', internal: false, ...extra });

const MACOS = {
  lo0: [v4('127.0.0.1', { internal: true, mac: NO_MAC }), v6('::1', { internal: true, mac: NO_MAC })],
  en0: [v6('fe80::1c2b:3d4e'), v6('2a06:c701::1'), v4('10.0.0.12')],
  awdl0: [v6('fe80::a0b1:c2d3')],
  utun0: [v6('fe80::ce81:b1c', { mac: NO_MAC })],
  bridge100: [v4('192.168.64.1', { mac: '3e:22:fb:00:00:64' })],
  utun4: [v4('10.8.0.2', { mac: NO_MAC })],
};

test('listInterfaces drops loopback, and interfaces with nothing but link-local addresses', () => {
  const names = network.listInterfaces(MACOS).map((entry) => entry.name);
  assert.deepEqual(names, ['en0', 'bridge100', 'utun4']);
});

test('listInterfaces puts IPv4 first and leaves link-local addresses out', () => {
  const [en0] = network.listInterfaces(MACOS);
  assert.deepEqual(en0.addresses, [
    { family: 'IPv4', address: '10.0.0.12', cidr: '10.0.0.12/24' },
    { family: 'IPv6', address: '2a06:c701::1', cidr: '2a06:c701::1/64' },
  ]);
});

test('listInterfaces marks the default route\'s interface and puts it first', () => {
  const interfaces = network.listInterfaces(MACOS, '10.8.0.2');
  assert.equal(interfaces[0].name, 'utun4');
  assert.deepEqual(interfaces.map((entry) => entry.primary), [true, false, false]);
});

test('listInterfaces reports a tunnel\'s all-zero hardware address as none', () => {
  const utun4 = network.listInterfaces(MACOS).find((entry) => entry.name === 'utun4');
  assert.equal(utun4.mac, null);
});

test('parseTrace reads the ip= line of the trace page', () => {
  const trace = 'fl=29f1\nh=1.1.1.1\nip=203.0.113.7\nts=1761384038.23\nvisit_scheme=https\nloc=IL\n';
  assert.equal(network.parseTrace(trace), '203.0.113.7');
});

test('parseTrace is null for anything that is not an address, so a portal page is not an answer', () => {
  assert.equal(network.parseTrace('<html><body>Sign in to the Wi-Fi</body></html>'), null);
  assert.equal(network.parseTrace('ip=not-an-address\n'), null);
  assert.equal(network.parseTrace(''), null);
});

test('primaryAddress is one of this machine\'s own addresses, or null with no route', async () => {
  const address = await network.primaryAddress();
  if (address === null) return;
  const own = Object.values(os.networkInterfaces()).flat().map((entry) => entry.address);
  assert.ok(own.includes(address), `${address} is not on any interface`);
});

test('a reading with the lookup off says so with a null publicIp, not a failed one', async () => {
  const reading = await network.read();
  assert.match(reading.readAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(reading.hostname, os.hostname());
  assert.equal(reading.publicIp, null);
  assert.ok(Array.isArray(reading.interfaces));
  if (reading.privateIp) {
    const primary = reading.interfaces.find((entry) => entry.primary);
    assert.equal(reading.privateIp.interface, primary?.name ?? null);
  }
});
