/**
 * Regression suite for ui/src/log-format.js — the rules that decide how a log line is painted.
 *
 * The module is pure and has no DOM in it, which is why it is worth having here: colouring a log
 * is guesswork by nature, and the guesses are the part that rots. Two properties carry most of
 * the weight. Concatenating the tokens must reproduce the line exactly, because a viewer that
 * quietly drops a character from a stack trace is worse than one with no colour at all; and a
 * level must come from a line that states one, not from a line that merely contains the word.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { highlight } from '../ui/src/log-format.js';

/** What the viewer would actually show, once the tokens are laid end to end. */
const shown = (message, pretty = false) =>
  highlight(message, pretty)
    .tokens.map((token) => token.text)
    .join('');

const levelOf = (message) => highlight(message).level;

/** The kinds a given substring was painted with. */
const kindsOf = (message, text, pretty = false) =>
  highlight(message, pretty)
    .tokens.filter((token) => token.text.includes(text))
    .map((token) => token.kind);

const RECORD = JSON.stringify({
  time: '2026-09-18T16:14:41.882Z',
  level: 'error',
  msg: 'upstream refused',
  stack: 'Error: connect ECONNREFUSED\n    at Socket.onError (net.js:1:1)',
  attempts: 3,
  fatal: false,
  cause: null,
  tags: ['api', 'billing'],
});

test('a line is reproduced exactly by its tokens, whatever it contains', () => {
  const lines = [
    RECORD,
    `12:01:02 worker ${JSON.stringify({ level: 'warn', msg: 'pool exhausted' })} (retrying)`,
    '[warn] compiled with 2 warnings in 340ms',
    'Local: http://127.0.0.1:5173/ ready in 412ms',
    '{"truncated":',
    'array [1] was empty',
    '{}',
    '',
    '   ',
  ];
  for (const line of lines) assert.equal(shown(line), line, line);
});

test('a record is painted as structure, and the prose around it is left as prose', () => {
  const message = `12:01:02 worker ${JSON.stringify({ msg: 'up' })}`;
  assert.deepEqual(kindsOf(message, '"msg"'), ['key']);
  assert.deepEqual(kindsOf(message, 'worker'), ['text']);
});

test("a record's level is read from its own field, in any of the spellings loggers use", () => {
  assert.equal(levelOf(RECORD), 'error');
  assert.equal(levelOf('{"lvl":"WARNING","msg":"x"}'), 'warn');
  assert.equal(levelOf('{"levelname":"DEBUG","msg":"x"}'), 'debug');
  assert.equal(levelOf('{"severity":"notice","msg":"x"}'), 'info');
});

test('numeric levels are read as pino writes them, and as syslog writes them', () => {
  assert.equal(levelOf('{"level":50,"msg":"x"}'), 'error'); // pino error
  assert.equal(levelOf('{"level":40,"msg":"x"}'), 'warn');
  assert.equal(levelOf('{"level":30,"msg":"x"}'), 'info');
  assert.equal(levelOf('{"severity":3,"msg":"x"}'), 'error'); // syslog err
  assert.equal(levelOf('{"severity":4,"msg":"x"}'), 'warn');
  assert.equal(levelOf('{"severity":6,"msg":"x"}'), 'info');
});

test('a prose line is levelled from a tag at its head', () => {
  assert.equal(levelOf('[warn] compiled with warnings'), 'warn');
  assert.equal(levelOf('ERROR: could not bind'), 'error');
  assert.equal(levelOf('12:01:02 debug resolved 40 modules'), 'debug');
});

test('a line that merely mentions a level is not levelled by it', () => {
  // The whole line gets tinted from this, so a false positive paints a healthy log red.
  assert.equal(levelOf('checked for errors and found 0'), null);
  assert.equal(levelOf('compiled with 2 warnings'), null);
  assert.equal(levelOf(`a${' '.repeat(80)}error at the far end of the line`), null);
});

test('a level word is still painted where it appears, even when the line is not levelled', () => {
  assert.deepEqual(kindsOf('saw an error here', 'error'), ['level-error']);
});

test("a level inside a record's message is not mistaken for the record's own level", () => {
  assert.equal(levelOf('{"msg":"no error occurred"}'), null);
});

test('Pretty breaks a record over several lines and indents it', () => {
  assert.equal(
    shown('{"a":{"b":[1,"two"]}}', true),
    ['{', '  "a": {', '    "b": [', '      1,', '      "two"', '    ]', '  }', '}'].join('\n')
  );
});

test('Pretty unescapes a newline inside a string, and indents what follows it', () => {
  // The point of the whole feature: an embedded stack trace is unreadable escaped, and it is the
  // thing you opened the log to read. The output is no longer valid JSON, deliberately.
  assert.equal(
    shown('{"stack":"Error: boom\\n    at Socket.onError (net.js:1:1)"}', true),
    '{\n  "stack": "Error: boom\n        at Socket.onError (net.js:1:1)"\n}'
  );
});

test('Pretty leaves a backslash-n that was literal text alone', () => {
  // Breaking on this would be inventing a line the process never wrote.
  assert.equal(shown(String.raw`{"s":"literal \\n here"}`, true), '{\n  "s": "literal \\\\n here"\n}');
});

test('Pretty does not reformat a bracket that was never JSON', () => {
  // `[1]` parses, but exploding it over three lines would break a sentence apart to do it.
  assert.equal(shown('array [1] was empty', true), 'array [1] was empty');
  assert.equal(shown('tags ["a","b"] applied', true), 'tags ["a","b"] applied');
});

test('Pretty does reformat an array that holds records of its own', () => {
  assert.equal(shown('[{"id":1}]', true), '[\n  {\n    "id": 1\n  }\n]');
});

test('a brace inside a string does not end the record early', () => {
  const message = '{"msg":"} not the end {","n":1}';
  assert.equal(shown(message), message);
  assert.deepEqual(kindsOf(message, '"n"'), ['key']);
});

test('an unparseable record falls back to prose rather than being dropped', () => {
  const message = '{"a":1,"b":';
  assert.equal(shown(message), message);
  assert.equal(kindsOf(message, '"a"').includes('key'), false);
});

test('a line too long to be worth tokenising is handed back whole', () => {
  // No tokens means "draw it plain": the viewer falls back to the raw message, uncoloured.
  const huge = `{"blob":"${'x'.repeat(70_000)}"}`;
  assert.deepEqual(highlight(huge), { level: null, tokens: [] });
});
