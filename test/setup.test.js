/**
 * First-run setup and Paddock's logo, through service.js — the same calls the REST routes make.
 *
 * The tests run in order against one fresh data directory, chosen before the first import because
 * config.js reads the environment at module load: a fresh install first, then one that has an
 * application, then one that finished setup. The logo is stored beside the configuration, never in it.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'paddock-setup-test-'));
process.env.PADDOCK_DATA_DIR = DATA_DIR;
// A .env beside the project root would otherwise leak the developer's settings into the run.
process.env.PADDOCK_ENV_FILE = path.join(DATA_DIR, 'absent.env');
process.env.PADDOCK_LOG_PERSIST = 'false';
process.env.PADDOCK_REAP_ORPHANS = 'false';

const service = await import('../service.js');
const { MAX_LOGO_BYTES } = await import('../branding.js');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64'
);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';

/** @param {string} type the label the data URL claims @param {Buffer|string} bytes */
const dataUrl = (type, bytes) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

const readDocument = async () => JSON.parse(await fs.readFile(path.join(DATA_DIR, 'applications.json'), 'utf8'));

after(async () => {
  await service.shutdown();
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

test('a fresh install needs setup and has never completed it', async () => {
  assert.deepEqual(await service.getSetup(), { completedAt: null, needed: true });
});

test('a copy that already has an application does not open setup, finished or not', async () => {
  await service.createApplication({ name: 'set-up-by-hand' });
  assert.deepEqual(await service.getSetup(), { completedAt: null, needed: false });
});

test('completing setup records when, beside the MCP preferences and without touching them', async () => {
  const mcpBefore = (await readDocument()).preferences.mcp;

  const view = await service.completeSetup();
  assert.equal(view.needed, false);
  assert.ok(!Number.isNaN(Date.parse(view.completedAt)), `completedAt is a date: ${view.completedAt}`);

  const doc = await readDocument();
  assert.deepEqual(doc.preferences.setup, { completedAt: view.completedAt });
  assert.deepEqual(doc.preferences.mcp, mcpBefore);
});

test('no logo is set until one is chosen, and resetting with none set is not an error', async () => {
  assert.deepEqual(await service.getBranding(), { logo: null });
  assert.deepEqual(await service.resetLogo(), { logo: null });
});

test('a logo round-trips as a data URL, typed from its bytes rather than its label', async () => {
  const { logo } = await service.setLogo({ dataUrl: dataUrl('image/png', SVG) });
  assert.equal(logo.contentType, 'image/svg+xml');
  assert.equal(logo.bytes, Buffer.byteLength(SVG));
  assert.equal(logo.dataUrl, dataUrl('image/svg+xml', SVG));

  assert.deepEqual(await service.getBranding(), { logo });
  // Kept beside the configuration, never inside it: the document is rewritten on every change.
  assert.equal(JSON.stringify(await readDocument()).includes(logo.dataUrl), false);
});

test('a new logo replaces the old one, and reset brings Paddock\'s mark back', async () => {
  const { logo } = await service.setLogo({ dataUrl: dataUrl('image/png', PNG) });
  assert.equal(logo.contentType, 'image/png');
  assert.equal((await service.getBranding()).logo.dataUrl, logo.dataUrl);

  assert.deepEqual(await service.resetLogo(), { logo: null });
  assert.deepEqual(await service.getBranding(), { logo: null });
});

test('a logo that is not an image, not a data URL, or too large is refused and nothing is stored', async () => {
  const refusals = [
    [{ dataUrl: dataUrl('image/png', '<!doctype html><title>app</title>') }, /must be a PNG, ICO, GIF, JPEG, WebP or SVG/],
    [{ dataUrl: 'https://example.com/logo.png' }, /base64 data: URL/],
    [{ dataUrl: 'data:image/png;base64,not base64!' }, /base64 data: URL/],
    [{}, /base64 data: URL/],
    [{ dataUrl: dataUrl('image/png', Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)])) }, /KiB or smaller/],
  ];
  for (const [input, message] of refusals) {
    await assert.rejects(service.setLogo(input), { name: 'ValidationError', message });
  }
  assert.deepEqual(await service.getBranding(), { logo: null });
});

test('a torn logo file reads as no logo instead of failing the dashboard', async () => {
  await fs.writeFile(path.join(DATA_DIR, 'logo.json'), '{"contentType":"image/png","upd');
  assert.deepEqual(await service.getBranding(), { logo: null });
});
