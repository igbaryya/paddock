/**
 * Regression suite for json-db.js — the atomic single-document store.
 *
 * Two things shape this file. json-db.js resolves DB_FILE through config.js at import time, so the
 * data directory has to exist in the environment before the first `await import()` of anything in
 * the project. And json-db.js caches the parsed document in module state, so a test that needs a
 * cold load (corrupt recovery, a refused version, an unreadable file) imports the module under a
 * fresh query string: that yields a new module instance — new cache, new mutex — while config.js,
 * whose specifier is unchanged, stays resolved to the same DB_FILE. One test uses a real child
 * process instead, to prove the bytes on disk are what a second run actually sees.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROJECT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODULE_URL = pathToFileURL(path.join(PROJECT_DIR, 'json-db.js')).href;

// Created before the first project import, because config.js reads the environment once.
const DATA_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'paddock-test-'));
// A .env beside the project would otherwise leak into this run; point the loader at nothing.
const NO_ENV_FILE = path.join(DATA_DIR, 'absent.env');
process.env.PADDOCK_DATA_DIR = DATA_DIR;
process.env.PADDOCK_ENV_FILE = NO_ENV_FILE;

const DB_FILE = path.join(DATA_DIR, 'applications.json');

const DEFAULT_MCP_PREFERENCES = {
  port: null,
  configured: false,
  enabled: false,
  lastStartedAt: null,
  lastStoppedAt: null,
  audit: [],
};

const DEFAULT_DOCUMENT = {
  version: 1,
  applications: [],
  preferences: { mcp: DEFAULT_MCP_PREFERENCES },
};

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let instances = 0;

/** A module instance with a cold cache, against whatever is currently on disk. */
const loadDb = () => import(`${MODULE_URL}?instance=${(instances += 1)}`);

/** A module instance with a cold cache and an empty data directory. */
async function freshDb() {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
  return loadDb();
}

/** Run `source` in a child node process pointed at the same data directory. */
async function runInChild(source) {
  const prelude = `const db = await import(${JSON.stringify(MODULE_URL)});\n`;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', prelude + source], {
    env: {
      ...process.env,
      PADDOCK_DATA_DIR: DATA_DIR,
      PADDOCK_ENV_FILE: NO_ENV_FILE,
    },
  });
  return stdout;
}

const listDataDir = async () => (await fs.readdir(DATA_DIR)).sort();

const readDisk = async () => JSON.parse(await fs.readFile(DB_FILE, 'utf8'));

const exists = (file) => fs.access(file).then(() => true, () => false);

after(async () => {
  await fs.chmod(DB_FILE, 0o600).catch(() => {});
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

describe('json-db', () => {
  test('a fresh data directory yields the default document and creates no file', async () => {
    const db = await freshDb();

    assert.deepEqual(await db.read(), DEFAULT_DOCUMENT);
    assert.deepEqual(await listDataDir(), []);
  });

  test('read() hands out a copy — mutating it does not change the store', async () => {
    const db = await freshDb();

    const cold = await db.read();
    cold.applications.push({ id: 'app_scribble00' });
    cold.version = 98;

    // The second read comes from the warm cache, which is where a leaked reference would show up.
    const warm = await db.read();
    assert.deepEqual(warm, DEFAULT_DOCUMENT);
    warm.applications.push({ id: 'app_scribble01' });
    warm.version = 99;

    assert.deepEqual(await db.read(), DEFAULT_DOCUMENT);
  });

  test('update() hands out a copy — mutating its result does not change the store', async () => {
    const db = await freshDb();

    const returned = await db.update((doc) => {
      doc.applications.push({ id: 'app_kept000000' });
      return doc;
    });
    returned.applications.push({ id: 'app_scribble02' });

    assert.deepEqual((await db.read()).applications, [{ id: 'app_kept000000' }]);
    assert.deepEqual((await readDisk()).applications, [{ id: 'app_kept000000' }]);
  });

  test('update() persists the document and a later read() returns the stored value', async () => {
    const db = await freshDb();
    const application = { id: 'app_api00000000', name: 'api', processes: [] };

    const returned = await db.update((doc) => {
      doc.applications.push(application);
      return doc;
    });

    assert.deepEqual(returned, { version: 1, applications: [application], preferences: { mcp: DEFAULT_MCP_PREFERENCES } });
    assert.deepEqual(await db.read(), returned);
    assert.deepEqual(await readDisk(), returned);
    assert.deepEqual(await listDataDir(), ['applications.json']);
  });

  test('the stored document is not readable by group or other', async () => {
    const db = await freshDb();
    await db.update((doc) => doc);

    const { mode } = await fs.stat(DB_FILE);
    assert.equal(mode & 0o077, 0, `expected no group/other bits, got ${(mode & 0o777).toString(8)}`);
  });

  test('a fresh import in a child process reads the written value, not a cache', async () => {
    const db = await freshDb();
    await db.update((doc) => {
      doc.applications.push({ id: 'app_child0000', name: 'written-by-parent', processes: [] });
      return doc;
    });

    const stdout = await runInChild('process.stdout.write(JSON.stringify(await db.read()));');

    assert.deepEqual(JSON.parse(stdout), {
      version: 1,
      // The child's read migrates the document, which fills in the kind the parent left out.
      applications: [
        { id: 'app_child0000', name: 'written-by-parent', kind: 'processes', postgres: null, processes: [] },
      ],
      preferences: { mcp: DEFAULT_MCP_PREFERENCES },
    });
  });

  test('every one of many concurrent update() calls survives — no lost update', async () => {
    const db = await freshDb();
    const count = 60;

    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        db.update((doc) => {
          doc.applications.push({ id: `app_${String(i).padStart(9, '0')}`, index: i });
          return doc;
        })
      )
    );

    const expected = Array.from({ length: count }, (_, i) => i);
    const indexes = (await db.read()).applications.map((app) => app.index).sort((a, b) => a - b);
    assert.deepEqual(indexes, expected);

    const onDisk = (await readDisk()).applications.map((app) => app.index).sort((a, b) => a - b);
    assert.deepEqual(onDisk, expected);
  });

  test('a mutate that throws rejects only its own caller and leaves the chain usable (F3)', async () => {
    const db = await freshDb();
    const boom = new Error('mutate exploded');

    // Queued in one synchronous burst, so the failure lands in the middle of the chain.
    const settled = await Promise.allSettled([
      db.update((doc) => {
        doc.applications.push({ id: 'app_first00000' });
        return doc;
      }),
      db.update((doc) => {
        // The abandoned edit must not survive in the cache either.
        doc.applications.push({ id: 'app_ghost00000' });
        throw boom;
      }),
      db.update((doc) => {
        doc.applications.push({ id: 'app_third00000' });
        return doc;
      }),
    ]);

    assert.deepEqual(
      settled.map((r) => r.status),
      ['fulfilled', 'rejected', 'fulfilled']
    );
    assert.equal(settled[1].reason, boom);

    // The chain must still accept work after the rejection, and the failed mutation must be absent.
    const after = await db.update((doc) => {
      doc.applications.push({ id: 'app_fourth0000' });
      return doc;
    });
    const ids = after.applications.map((app) => app.id);
    assert.deepEqual(ids, ['app_first00000', 'app_third00000', 'app_fourth0000']);
    assert.deepEqual((await readDisk()).applications.map((app) => app.id), ids);
  });

  test('update() refuses a mutate that does not return a document, leaving disk untouched', async () => {
    const db = await freshDb();
    await db.update((doc) => {
      doc.applications.push({ id: 'app_keep000000' });
      return doc;
    });
    const before = await fs.readFile(DB_FILE, 'utf8');

    await assert.rejects(
      () => db.update(() => undefined),
      (err) => err instanceof TypeError && /must return the new document object/.test(err.message)
    );

    assert.equal(await fs.readFile(DB_FILE, 'utf8'), before);
    assert.deepEqual((await db.read()).applications, [{ id: 'app_keep000000' }]);
  });

  test('repeated writes leave no .tmp files behind', async () => {
    const db = await freshDb();

    for (let i = 0; i < 5; i += 1) {
      await db.update((doc) => {
        doc.applications.push({ id: `app_${String(i).padStart(9, '0')}` });
        return doc;
      });
    }

    assert.deepEqual(await listDataDir(), ['applications.json']);
  });

  test('a write that fails mid-way leaves no .tmp file behind', async () => {
    const db = await freshDb();
    await db.update((doc) => {
      doc.applications.push({ id: 'app_survivor00' });
      return doc;
    });
    const before = await fs.readFile(DB_FILE, 'utf8');

    // A BigInt clones fine but cannot be serialised, so this fails after the temp file is opened.
    await assert.rejects(
      () => db.update((doc) => ({ ...doc, poison: 1n })),
      (err) => err instanceof TypeError && /BigInt/.test(err.message)
    );

    assert.deepEqual(await listDataDir(), ['applications.json']);
    assert.equal(await fs.readFile(DB_FILE, 'utf8'), before);
  });

  test('corrupt JSON is quarantined byte-for-byte and a second corruption keeps the first backup', async () => {
    await freshDb();
    const first = Buffer.from('{"version":1,"applications":[{"name":"café ☕","id":"app_trunc', 'utf8');
    await fs.writeFile(DB_FILE, first);

    const db = await loadDb();
    assert.deepEqual(await db.read(), DEFAULT_DOCUMENT);
    assert.deepEqual(await fs.readFile(`${DB_FILE}.corrupt-1`), first);
    // Recovery does not write a replacement; the default lives in memory until the first update.
    assert.equal(await exists(DB_FILE), false);

    const second = Buffer.from('{"version":1,"applications":[[[', 'utf8');
    await fs.writeFile(DB_FILE, second);

    const db2 = await loadDb();
    assert.deepEqual(await db2.read(), DEFAULT_DOCUMENT);
    assert.deepEqual(await fs.readFile(`${DB_FILE}.corrupt-2`), second);
    assert.deepEqual(await fs.readFile(`${DB_FILE}.corrupt-1`), first, 'the first backup was clobbered');
    assert.deepEqual(await listDataDir(), ['applications.json.corrupt-1', 'applications.json.corrupt-2']);
  });

  test('a valid JSON file that is not an object is quarantined too', async () => {
    await freshDb();
    await fs.writeFile(DB_FILE, '[1, 2, 3]');

    const db = await loadDb();

    assert.deepEqual(await db.read(), DEFAULT_DOCUMENT);
    assert.equal(await fs.readFile(`${DB_FILE}.corrupt-1`, 'utf8'), '[1, 2, 3]');
  });

  test('a hand-edited document with a broken shape is migrated, not thrown away (J4)', async () => {
    await freshDb();
    await fs.writeFile(
      DB_FILE,
      JSON.stringify({ applications: [null, 'nonsense', { id: 'app_kept000000' }, { id: 'app_procs00000', processes: 'oops' }] })
    );

    const db = await loadDb();

    assert.deepEqual(await db.read(), {
      version: 1,
      applications: [
        { id: 'app_kept000000', kind: 'processes', postgres: null, processes: [] },
        { id: 'app_procs00000', kind: 'processes', postgres: null, processes: [] },
      ],
      preferences: { mcp: DEFAULT_MCP_PREFERENCES },
    });
    assert.deepEqual(await listDataDir(), ['applications.json'], 'a migratable document must not be quarantined');
  });

  test('a document from a newer build is refused and left untouched on disk (J3)', async () => {
    await freshDb();
    const raw = `${JSON.stringify({ version: 2, applications: [{ id: 'app_future0000' }] }, null, 2)}\n`;
    await fs.writeFile(DB_FILE, raw);
    const db = await loadDb();

    await assert.rejects(
      () => db.read(),
      (err) => {
        assert.equal(err instanceof db.UnsupportedVersionError, true);
        assert.equal(err.name, 'UnsupportedVersionError');
        assert.equal(err.version, 2);
        assert.match(err.message, /newer version of paddock/);
        return true;
      }
    );
    // A refusal is not a recovery: nothing renamed, nothing rewritten, and update() refuses as well.
    await assert.rejects(() => db.update((doc) => doc), { name: 'UnsupportedVersionError' });
    assert.equal(await fs.readFile(DB_FILE, 'utf8'), raw);
    assert.deepEqual(await listDataDir(), ['applications.json']);
  });

  test('an unreadable document propagates EACCES and is never quarantined', { skip: isRoot && 'root ignores the permission bits' }, async () => {
    await freshDb();
    const raw = JSON.stringify({ version: 1, applications: [{ id: 'app_healthy000' }] });
    await fs.writeFile(DB_FILE, raw);
    await fs.chmod(DB_FILE, 0o000);
    const db = await loadDb();

    await assert.rejects(() => db.read(), (err) => err.code === 'EACCES');

    await fs.chmod(DB_FILE, 0o600);
    assert.equal(await fs.readFile(DB_FILE, 'utf8'), raw, 'the healthy file must still be in place');
    assert.deepEqual(await listDataDir(), ['applications.json']);
  });
});

// The data directory belongs to this run alone; leaving it behind accumulates one
// directory per run in the system temp folder.
after(() => {
  fsSync.rmSync(DATA_DIR, { recursive: true, force: true });
});
