/**
 * Regression suite for log-store.js — the bounded ring buffer, the global seq cursor protocol and
 * the JSONL sink.
 *
 * config.js reads the environment once, at import time, so every knob this file needs is set before
 * the first dynamic import of the module under test. The one scenario that cannot share that module
 * instance (LOG_PERSIST=false) runs in a child process with its own data directory.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOG_STORE = path.join(PROJECT_DIR, 'log-store.js');

/** Small enough that a handful of appends can overflow it, large enough for the other cases. */
const BUFFER_LINES = 8;
/** Tiny enough that ~6 padded lines force exactly one rotation. */
const FILE_MAX_BYTES = 1024;

const DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'paddock-test-'));
const tempDirs = [DATA_DIR];

// Set before the first import of any project module — config.js snapshots these at import time.
process.env.PADDOCK_ENV_FILE = path.join(DATA_DIR, 'absent.env'); // ignore the developer's .env
process.env.PADDOCK_DATA_DIR = DATA_DIR;
process.env.PADDOCK_LOG_BUFFER_LINES = String(BUFFER_LINES);
process.env.PADDOCK_LOG_FILE_MAX_BYTES = String(FILE_MAX_BYTES);
process.env.PADDOCK_LOG_PERSIST = 'true';

const store = await import(LOG_STORE);

const LOG_DIR = path.join(DATA_DIR, 'logs');
const jsonlPath = (appId, procId, suffix = '') =>
  path.join(LOG_DIR, appId, `${procId}${suffix}.jsonl`);

const readAll = (appId, procIds) =>
  store.read({ applicationId: appId, processIds: procIds, limit: 10_000 });

const messages = (entries) => entries.map((entry) => entry.message);
const seqs = (entries) => entries.map((entry) => entry.seq);

/** Poll until `probe` returns something truthy, or fail with a message naming what we waited for. */
async function waitFor(label, probe, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Non-empty lines of a JSONL file, plus the raw text so a torn line is visible in a failure. */
async function readJsonl(file) {
  const raw = await readFile(file, 'utf8');
  return { raw, lines: raw.split('\n').filter((line) => line !== '') };
}

/**
 * Run a script in its own process — the only way to give log-store a different LOG_PERSIST, since
 * config.js binds the environment at import time. The script gets a fresh, empty data directory and
 * lives outside it, so a listing of that directory shows only what the module under test wrote.
 * @returns {Promise<object>} the JSON the child printed on stdout, plus its `dataDir`
 */
async function runChild(source, env, seed) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'paddock-test-'));
  tempDirs.push(dir);
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  await seed?.(dataDir);
  const script = path.join(dir, 'child.mjs');
  await writeFile(script, source);
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      PADDOCK_DATA_DIR: dataDir,
      PADDOCK_ENV_FILE: path.join(dir, 'absent.env'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => (chunks.stdout += d));
  child.stderr.on('data', (d) => (chunks.stderr += d));
  const kill = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const [code, signal] = await new Promise((resolve) => child.once('close', (c, s) => resolve([c, s])));
  clearTimeout(kill);
  assert.equal(code, 0, `child exited ${code}/${signal}: ${chunks.stderr}`);
  return { ...JSON.parse(chunks.stdout.trim()), dataDir };
}

before(() => {
  assert.equal(store.read({ applicationId: 'probe', processIds: [] }).nextSeq, 1,
    'the global seq counter must start at 1');
});

after(async () => {
  await store.closeAll();
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// seq
// ---------------------------------------------------------------------------------------------

test('append returns the stored entry with an increasing seq and a normalised stream', () => {
  const a = store.append('app_seq', 'proc_seq', 'stdout', 'first');
  const b = store.append('app_seq', 'proc_seq', 'stderr', 'second');

  assert.equal(b.seq, a.seq + 1);
  assert.equal(a.stream, 'stdout');
  assert.equal(b.stream, 'stderr');
  assert.equal(a.processId, 'proc_seq');
  assert.equal(a.message, 'first');
  assert.equal(new Date(a.ts).toISOString(), a.ts, `ts must be an ISO string, got ${a.ts}`);
});

test('the seq counter is global across applications and processes, so appends interleave', () => {
  const one = store.append('app_gA', 'proc_gA', 'stdout', 'A1');
  const two = store.append('app_gB', 'proc_gB', 'stdout', 'B1');
  const three = store.append('app_gA', 'proc_gA', 'stdout', 'A2');
  const four = store.append('app_gB', 'proc_gB', 'stdout', 'B2');

  assert.deepEqual(
    [two.seq, three.seq, four.seq],
    [one.seq + 1, one.seq + 2, one.seq + 3],
    'a seq handed to one application must not be reused by another'
  );
  assert.deepEqual(seqs(readAll('app_gA', ['proc_gA']).entries), [one.seq, three.seq]);
  assert.deepEqual(seqs(readAll('app_gB', ['proc_gB']).entries), [two.seq, four.seq]);
});

// ---------------------------------------------------------------------------------------------
// read: limit, order, stream filter
// ---------------------------------------------------------------------------------------------

test('read with a limit returns the most recent N in ascending seq order', () => {
  const appended = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'].map((m) =>
    store.append('app_limit', 'proc_limit', 'stdout', m)
  );

  const { entries } = store.read({
    applicationId: 'app_limit',
    processIds: ['proc_limit'],
    limit: 3,
  });

  assert.deepEqual(messages(entries), ['l4', 'l5', 'l6']);
  assert.deepEqual(seqs(entries), appended.slice(-3).map((e) => e.seq));
});

test('read filters by stream while keeping the global seq numbering', () => {
  const out1 = store.append('app_filter', 'proc_filter', 'stdout', 'o1');
  store.append('app_filter', 'proc_filter', 'stderr', 'e1');
  const out2 = store.append('app_filter', 'proc_filter', 'stdout', 'o2');

  const { entries } = store.read({
    applicationId: 'app_filter',
    processIds: ['proc_filter'],
    stream: 'stdout',
    limit: 100,
  });

  assert.deepEqual(messages(entries), ['o1', 'o2']);
  assert.deepEqual(seqs(entries), [out1.seq, out2.seq]);
});

// ---------------------------------------------------------------------------------------------
// cursors
// ---------------------------------------------------------------------------------------------

test('read({ sinceSeq: nextSeq }) returns only entries appended after the cursor', () => {
  store.append('app_cur', 'proc_cur', 'stdout', 'before-1');
  store.append('app_cur', 'proc_cur', 'stdout', 'before-2');

  const first = readAll('app_cur', ['proc_cur']);
  assert.deepEqual(messages(first.entries), ['before-1', 'before-2']);

  const after1 = store.append('app_cur', 'proc_cur', 'stdout', 'after-1');
  const after2 = store.append('app_cur', 'proc_cur', 'stdout', 'after-2');

  const second = store.read({
    applicationId: 'app_cur',
    processIds: ['proc_cur'],
    sinceSeq: first.nextSeq,
    limit: 100,
  });

  assert.deepEqual(messages(second.entries), ['after-1', 'after-2']);
  assert.deepEqual(seqs(second.entries), [after1.seq, after2.seq]);
  assert.equal(second.nextSeq, after2.seq + 1, 'nextSeq must advance past the newest entry');
  assert.equal(second.dropped, false);
});

test('a cursor read with nothing new returns an empty array, not the tail', () => {
  store.append('app_idle', 'proc_idle', 'stdout', 'only');

  const first = readAll('app_idle', ['proc_idle']);
  const second = store.read({
    applicationId: 'app_idle',
    processIds: ['proc_idle'],
    sinceSeq: first.nextSeq,
    limit: 100,
  });

  assert.deepEqual(second.entries, []);
  assert.equal(second.nextSeq, first.nextSeq, 'an idle poll must not move the cursor');
  assert.equal(second.dropped, false);
});

test('a cursor equal to a still-buffered seq re-delivers that entry, not the one before it', () => {
  const a = store.append('app_incl', 'proc_incl', 'stdout', 'x1');
  const b = store.append('app_incl', 'proc_incl', 'stdout', 'x2');

  const { entries } = store.read({
    applicationId: 'app_incl',
    processIds: ['proc_incl'],
    sinceSeq: b.seq,
    limit: 100,
  });

  assert.deepEqual(seqs(entries), [b.seq]);
  assert.notDeepEqual(seqs(entries), [a.seq, b.seq]);
});

// ---------------------------------------------------------------------------------------------
// eviction and the dropped flag
// ---------------------------------------------------------------------------------------------

test('the ring evicts the oldest entries and never grows past LOG_BUFFER_LINES', () => {
  const appended = [];
  for (let i = 1; i <= 20; i += 1) {
    appended.push(store.append('app_evict', 'proc_evict', 'stdout', `e${i}`));
  }

  const { entries } = readAll('app_evict', ['proc_evict']);

  assert.equal(entries.length, BUFFER_LINES);
  assert.deepEqual(messages(entries), ['e13', 'e14', 'e15', 'e16', 'e17', 'e18', 'e19', 'e20']);
  assert.deepEqual(seqs(entries), appended.slice(-BUFFER_LINES).map((e) => e.seq));
  assert.deepEqual(
    seqs(entries),
    [...seqs(entries)].sort((x, y) => x - y),
    'the ring must be returned in seq order across the wrap point'
  );
});

test('dropped is false for a fresh cursorless read even after eviction has occurred', () => {
  for (let i = 1; i <= 20; i += 1) store.append('app_gap', 'proc_gap', 'stdout', `g${i}`);

  const fresh = readAll('app_gap', ['proc_gap']);

  assert.equal(fresh.dropped, false, 'a caller that sent no cursor has missed nothing by definition');
  assert.equal(fresh.entries.length, BUFFER_LINES);
});

test('dropped is true only for a numeric cursor older than the oldest buffered entry', () => {
  const appended = [];
  for (let i = 1; i <= 20; i += 1) {
    appended.push(store.append('app_stale', 'proc_stale', 'stdout', `s${i}`));
  }
  const evictedSeq = appended[0].seq;
  const oldestBuffered = appended[appended.length - BUFFER_LINES].seq;

  const stale = store.read({
    applicationId: 'app_stale',
    processIds: ['proc_stale'],
    sinceSeq: evictedSeq,
    limit: 100,
  });
  assert.equal(stale.dropped, true, `cursor ${evictedSeq} is older than ${oldestBuffered}`);
  assert.equal(stale.entries.length, BUFFER_LINES);

  const intact = store.read({
    applicationId: 'app_stale',
    processIds: ['proc_stale'],
    sinceSeq: oldestBuffered,
    limit: 100,
  });
  assert.equal(intact.dropped, false, 'the oldest surviving entry is not a gap');

  const empty = store.read({
    applicationId: 'app_stale',
    processIds: ['proc_stale'],
    sinceSeq: '',
    limit: 100,
  });
  assert.equal(empty.dropped, false, "an empty-string sinceSeq is 'no cursor', not seq 0");
});

test('a cursor still works after eviction: it delivers only what arrived after it', () => {
  for (let i = 1; i <= 20; i += 1) store.append('app_post', 'proc_post', 'stdout', `p${i}`);

  const afterFlood = readAll('app_post', ['proc_post']);
  const fresh1 = store.append('app_post', 'proc_post', 'stdout', 'p21');
  const fresh2 = store.append('app_post', 'proc_post', 'stdout', 'p22');

  const tail = store.read({
    applicationId: 'app_post',
    processIds: ['proc_post'],
    sinceSeq: afterFlood.nextSeq,
    limit: 100,
  });

  assert.deepEqual(messages(tail.entries), ['p21', 'p22']);
  assert.deepEqual(seqs(tail.entries), [fresh1.seq, fresh2.seq]);
  assert.equal(tail.dropped, false);
  assert.equal(tail.nextSeq, fresh2.seq + 1);
});

// ---------------------------------------------------------------------------------------------
// application-wide reads
// ---------------------------------------------------------------------------------------------

test('an application-wide read merges its processes in seq order, each entry tagged', () => {
  const a1 = store.append('app_merge', 'proc_a', 'stdout', 'a1');
  const b1 = store.append('app_merge', 'proc_b', 'stderr', 'b1');
  const a2 = store.append('app_merge', 'proc_a', 'stdout', 'a2');
  const b2 = store.append('app_merge', 'proc_b', 'stdout', 'b2');

  const { entries, nextSeq } = readAll('app_merge', ['proc_a', 'proc_b']);

  assert.deepEqual(messages(entries), ['a1', 'b1', 'a2', 'b2']);
  assert.deepEqual(seqs(entries), [a1.seq, b1.seq, a2.seq, b2.seq]);
  assert.deepEqual(entries.map((e) => e.processId), ['proc_a', 'proc_b', 'proc_a', 'proc_b']);
  assert.equal(nextSeq, b2.seq + 1);
});

test('an application-wide limit takes the newest N across all its processes', () => {
  const appended = [
    store.append('app_mlimit', 'proc_x', 'stdout', 'm1'),
    store.append('app_mlimit', 'proc_y', 'stdout', 'm2'),
    store.append('app_mlimit', 'proc_x', 'stdout', 'm3'),
    store.append('app_mlimit', 'proc_y', 'stdout', 'm4'),
  ];

  const { entries } = store.read({
    applicationId: 'app_mlimit',
    processIds: ['proc_x', 'proc_y'],
    limit: 2,
  });

  assert.deepEqual(messages(entries), ['m3', 'm4']);
  assert.deepEqual(seqs(entries), [appended[2].seq, appended[3].seq]);
});

// ---------------------------------------------------------------------------------------------
// sanitisation
// ---------------------------------------------------------------------------------------------

test('ANSI escapes are stripped from the stored message', () => {
  const cases = [
    ['[31mRED[39m', 'RED'],
    ['[2K[1Gprogress 50%', 'progress 50%'],
    ['[1;32mok[0m done', 'ok done'],
    // OSC-8 hyperlink, BEL-terminated, as emitted by vite and friends
    [']8;;https://example.com/xclick here]8;;', 'click here'],
    // OSC terminated by ST (ESC backslash) instead of BEL
    [']0;window title\\after the title', 'after the title'],
    // two-character escape
    ['Mreverse index', 'reverse index'],
  ];

  for (const [raw, expected] of cases) {
    const entry = store.append('app_ansi', 'proc_ansi', 'stdout', raw);
    assert.equal(entry.message, expected, `stripping ${JSON.stringify(raw)}`);
  }
});

test('text that merely looks like an escape sequence is left alone', () => {
  const plain = store.append('app_ansi2', 'proc_ansi2', 'stdout', '[31m not an escape ] 8;; x');
  assert.equal(plain.message, '[31m not an escape ] 8;; x');

  const empty = store.append('app_ansi2', 'proc_ansi2', 'stdout', '');
  assert.equal(empty.message, '', 'an empty line must survive as an empty line');
});

test('a trailing carriage return is removed but an interior one is kept', () => {
  const trailing = store.append('app_cr', 'proc_cr', 'stdout', 'done\r');
  assert.equal(trailing.message, 'done');

  const interior = store.append('app_cr', 'proc_cr', 'stdout', 'a\rb');
  assert.equal(interior.message, 'a\rb');

  const both = store.append('app_cr', 'proc_cr', 'stdout', '[32mgreen[0m\r');
  assert.equal(both.message, 'green');
});

// ---------------------------------------------------------------------------------------------
// JSONL persistence
// ---------------------------------------------------------------------------------------------

test('entries land in <LOG_DIR>/<appId>/<procId>.jsonl, one parseable object per line, in order', async () => {
  const appId = 'app_jsonl';
  const procId = 'proc_jsonl';
  const written = ['j1', 'j2', '[33mj3[0m', 'j4\r'].map((m) =>
    store.append(appId, procId, m === 'j2' ? 'stderr' : 'stdout', m)
  );
  const file = jsonlPath(appId, procId);

  const { raw, lines } = await waitFor(`4 lines in ${file}`, async () => {
    if (!fs.existsSync(file)) return null;
    const read = await readJsonl(file);
    return read.lines.length === 4 ? read : null;
  });

  assert.ok(raw.endsWith('\n'), 'every JSONL record must be newline-terminated');
  const records = lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`line ${i} is not valid JSON: ${JSON.stringify(line)} (${err.message})`);
    }
  });

  assert.deepEqual(records.map((r) => r.message), ['j1', 'j2', 'j3', 'j4'],
    'the persisted message is the sanitised one, in append order');
  assert.deepEqual(records.map((r) => r.seq), written.map((e) => e.seq));
  assert.deepEqual(records.map((r) => r.stream), ['stdout', 'stderr', 'stdout', 'stdout']);
  for (const record of records) {
    assert.equal(new Date(record.ts).toISOString(), record.ts, `bad ts ${record.ts}`);
  }
});

test('crossing LOG_FILE_MAX_BYTES rotates to .1.jsonl without losing or tearing a line', async () => {
  const appId = 'app_rotate';
  const procId = 'proc_rotate';
  const current = jsonlPath(appId, procId);
  const rotated = jsonlPath(appId, procId, '.1');
  // ~173 bytes per record, so one rotation lands after the sixth of eight lines.
  const padding = 'x'.repeat(100);
  const sent = [];
  for (let i = 1; i <= 8; i += 1) {
    sent.push(`rot-${String(i).padStart(2, '0')}-${padding}`);
    store.append(appId, procId, 'stdout', sent.at(-1));
  }

  await waitFor(`${rotated} to appear`, () => fs.existsSync(rotated));
  const both = await waitFor('all 8 records to be flushed across both files', async () => {
    const older = await readJsonl(rotated);
    const newer = await readJsonl(current);
    return older.lines.length + newer.lines.length === sent.length ? { older, newer } : null;
  });

  assert.ok(both.older.lines.length > 0, 'the rotated file must hold the earlier records');
  assert.ok(both.newer.lines.length > 0, 'writing must continue into a fresh current file');
  assert.ok(both.older.raw.endsWith('\n'), 'the rotated file must not end mid-record');

  const all = [...both.older.lines, ...both.newer.lines].map((line) => JSON.parse(line));
  assert.deepEqual(all.map((r) => r.message), sent, 'no record lost or reordered across rotation');
  assert.deepEqual(
    all.map((r) => r.seq),
    [...all.map((r) => r.seq)].sort((a, b) => a - b),
    'seq order must survive rotation'
  );

  const currentBytes = fs.statSync(current).size;
  assert.ok(currentBytes < FILE_MAX_BYTES,
    `the post-rotation file should be small, was ${currentBytes} bytes`);
});

test('LOG_PERSIST=false writes nothing to disk but still buffers in memory', async () => {
  const result = await runChild(
    `import fs from 'node:fs';
     const store = await import(${JSON.stringify(LOG_STORE)});
     store.append('app_off', 'proc_off', 'stdout', '\\u001b[31mno disk\\u001b[39m');
     store.append('app_off', 'proc_off', 'stderr', 'still buffered');
     await store.closeAll();
     const dataDir = process.env.PADDOCK_DATA_DIR;
     const read = store.read({ applicationId: 'app_off', processIds: ['proc_off'], limit: 100 });
     process.stdout.write(JSON.stringify({
       listing: fs.readdirSync(dataDir, { recursive: true }),
       messages: read.entries.map((e) => e.message),
       nextSeq: read.nextSeq,
     }));`,
    { PADDOCK_LOG_PERSIST: 'false' }
  );

  assert.deepEqual(result.listing, [],
    `LOG_PERSIST=false must leave the data directory empty, found ${result.listing.join(', ')}`);
  assert.deepEqual(result.messages, ['no disk', 'still buffered']);
  assert.equal(result.nextSeq, 3, 'the in-memory ring still numbers entries from 1');
});

test('a cold start rehydrates the ring from the JSONL tail, capped at LOG_BUFFER_LINES', async () => {
  const record = (i, message) =>
    `${JSON.stringify({ seq: i, ts: '2026-09-12T00:00:00.000Z', stream: 'stdout', message })}\n`;

  const result = await runChild(
    `const store = await import(${JSON.stringify(LOG_STORE)});
     const short = store.read({ applicationId: 'app_boot', processIds: ['proc_short'], limit: 100 });
     const long = store.read({ applicationId: 'app_boot', processIds: ['proc_long'], limit: 100 });
     process.stdout.write(JSON.stringify({
       short: short.entries.map((e) => [e.seq, e.processId, e.message]),
       long: long.entries.map((e) => e.message),
       nextSeq: long.nextSeq,
     }));`,
    {},
    async (dataDir) => {
      const dir = path.join(dataDir, 'logs', 'app_boot');
      fs.mkdirSync(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'proc_short.jsonl'),
        [record(41, 'old-a'), record(42, 'old-b'), record(43, 'old-c')].join('')
      );
      await writeFile(
        path.join(dir, 'proc_long.jsonl'),
        Array.from({ length: 12 }, (_, i) => record(i + 1, `hist-${i + 1}`)).join('')
      );
    }
  );

  // The previous run's numbering is gone: seq is a live cursor, reissued from 1 on this boot.
  assert.deepEqual(result.short, [
    [1, 'proc_short', 'old-a'],
    [2, 'proc_short', 'old-b'],
    [3, 'proc_short', 'old-c'],
  ]);
  assert.deepEqual(result.long, ['hist-5', 'hist-6', 'hist-7', 'hist-8', 'hist-9', 'hist-10',
    'hist-11', 'hist-12'], 'rehydration must not exceed the ring capacity');
  assert.equal(result.nextSeq, 12, 'three short records plus eight long ones were renumbered');
});

// ---------------------------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------------------------

test('clear empties one process buffer without touching another', () => {
  store.append('app_clear', 'proc_keep', 'stdout', 'keep-1');
  const doomed = store.append('app_clear', 'proc_drop', 'stdout', 'drop-1');
  store.append('app_clear', 'proc_keep', 'stdout', 'keep-2');
  store.append('app_clear', 'proc_drop', 'stdout', 'drop-2');

  store.clear('app_clear', 'proc_drop');

  assert.deepEqual(messages(readAll('app_clear', ['proc_drop']).entries), []);
  assert.deepEqual(messages(readAll('app_clear', ['proc_keep']).entries), ['keep-1', 'keep-2']);
  assert.deepEqual(
    messages(readAll('app_clear', ['proc_keep', 'proc_drop']).entries),
    ['keep-1', 'keep-2'],
    'a cleared process contributes nothing to an application-wide read'
  );

  const afterClear = store.append('app_clear', 'proc_drop', 'stdout', 'drop-3');
  assert.ok(afterClear.seq > doomed.seq, 'the global seq keeps climbing across a clear');
  assert.deepEqual(messages(readAll('app_clear', ['proc_drop']).entries), ['drop-3']);
});

test('clear leaves the JSONL history on disk — clearing a view is not deleting history', async () => {
  const appId = 'app_clearfile';
  const procId = 'proc_clearfile';
  store.append(appId, procId, 'stdout', 'persisted-1');
  store.append(appId, procId, 'stdout', 'persisted-2');
  const file = jsonlPath(appId, procId);

  await waitFor(`2 lines in ${file}`, async () => {
    if (!fs.existsSync(file)) return null;
    return (await readJsonl(file)).lines.length === 2;
  });

  store.clear(appId, procId);

  const { lines } = await readJsonl(file);
  assert.deepEqual(lines.map((l) => JSON.parse(l).message), ['persisted-1', 'persisted-2']);
  assert.deepEqual(messages(readAll(appId, [procId]).entries), [],
    'the cleared buffer must not rehydrate the history it just dropped');
});

// The data directory belongs to this run alone; leaving it behind accumulates one
// directory per run in the system temp folder.
after(async () => {
  await rm(DATA_DIR, { recursive: true, force: true });
});
