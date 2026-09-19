/**
 * Reading a log line: what level it reports, and the pieces it is made of.
 *
 * Dev servers write two kinds of line — prose, and one JSON record per event — and a tail of
 * either in a single colour is a wall of text. So a line is broken into tokens the viewer paints:
 * the keys and values of a record, the level word in prose, the numbers and the URLs.
 *
 * None of this can lean on the colours a process meant to print. The manager strips ANSI on the
 * way in (see log-store.js), deliberately — escape sequences are also cursor moves and screen
 * erases, and a log is a transcript, not a terminal. Everything here is derived from the text.
 *
 * The JSON path parses rather than pattern-matches, and that is what makes Pretty honest: the
 * output is a re-print of the value, not a regex guessing where a line may be broken. It is also
 * what lets the level come from the record's own field instead of from a word that happens to
 * appear somewhere in the message.
 */

/**
 * Past this a line is drawn plain. A line this long is minified output or a base64 blob — nobody
 * is reading it as a record, and tokenising it on every render would cost more than it is worth.
 */
const MAX_HIGHLIGHT_CHARS = 64_000;

/** Two spaces. A log viewport is narrow and a record nests deeply; four would run off the side. */
const INDENT = '  ';

/** The spellings loggers use, folded onto the four levels worth telling apart by colour. */
const LEVELS = new Map([
  ['fatal', 'error'], ['crit', 'error'], ['critical', 'error'], ['error', 'error'], ['err', 'error'],
  ['warn', 'warn'], ['warning', 'warn'],
  ['info', 'info'], ['notice', 'info'], ['log', 'info'],
  ['debug', 'debug'], ['trace', 'debug'], ['verbose', 'debug'], ['silly', 'debug'],
]);

/** What a record calls the field. `lvl` and `levelname` are pino and Python's logging module. */
const LEVEL_KEYS = new Set(['level', 'lvl', 'levelname', 'severity']);

/**
 * A level word, wherever it appears. Only the word is painted from this — the line as a whole is
 * tinted from `levelOf`, which is far more careful, because "0 errors" must not turn a line red.
 */
const PROSE = new RegExp(
  [
    '(https?://[^\\s"\'<>)\\]]+)', // first, so nothing inside a URL is split back out of it
    '("(?:[^"\\\\]|\\\\.)*")',
    '\\b(fatal|error|warn(?:ing)?|info|debug|trace)\\b',
    '\\b(\\d+(?:\\.\\d+)?(?:ms|s|kb|mb|gb|%)?)\\b',
  ].join('|'),
  'gi'
);

/**
 * A level a prose line is actually reporting, rather than one it mentions: a tag at the head of
 * the line, as every prose logger writes it — `[warn]`, `ERROR:`, `12:01:02 debug compiled`.
 */
const PROSE_LEVEL = /(?:^|[[(\s])(fatal|error|warn(?:ing)?|info|debug|trace)(?=[\])\s:.,-]|$)/i;

/** How far into a line that tag may be before it is just a word in a sentence. */
const PROSE_LEVEL_REACH = 64;

/**
 * Numeric levels, as pino and syslog write them: pino's 50 is error, 40 warn, 30 info, and
 * anything below that is debug or trace. Syslog counts the other way but only reaches 7, so the
 * two never collide.
 */
function numericLevel(value) {
  if (value >= 50) return 'error';
  if (value >= 40) return 'warn';
  if (value >= 30) return 'info';
  if (value >= 10) return 'debug';
  // Syslog: 0..7, ascending in severity the other way round.
  if (value <= 3) return 'error';
  if (value === 4) return 'warn';
  if (value === 5 || value === 6) return 'info';
  return 'debug';
}

/** @param {unknown} value @returns {string|null} one of error, warn, info, debug */
function levelFrom(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return numericLevel(value);
  if (typeof value !== 'string') return null;
  return LEVELS.get(value.trim().toLowerCase()) ?? null;
}

/** The level a record states, read from whichever field it uses to state it. */
function recordLevel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    if (LEVEL_KEYS.has(key.toLowerCase())) {
      const level = levelFrom(item);
      if (level) return level;
    }
  }
  return null;
}

function proseLevel(text) {
  const match = PROSE_LEVEL.exec(text.slice(0, PROSE_LEVEL_REACH));
  return match ? LEVELS.get(match[1].toLowerCase()) ?? null : null;
}

/**
 * The end of the JSON value that starts at `start`, or -1. Counts depth while skipping anything
 * inside a string, because a brace in a message field is not a brace in the structure.
 */
function matchingEnd(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i += 1; // the escaped character cannot end the string, whatever it is
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close && (depth -= 1) === 0) return i;
  }
  return -1;
}

/**
 * Structure worth reformatting, as opposed to a value that merely parses. An object always counts;
 * an array only counts when it holds structure of its own, because `[1]` and `[a, b]` turn up in
 * ordinary prose all the time and Pretty would otherwise break a sentence across three lines to
 * reformat a bracket nobody meant as JSON.
 */
const isRecord = (value) =>
  value !== null &&
  typeof value === 'object' &&
  (!Array.isArray(value) || value.some((item) => item !== null && typeof item === 'object'));

/**
 * The JSON record in a line, if there is one. Loggers prefix theirs as often as not — a timestamp,
 * a worker name — so this finds the value rather than requiring the line to be nothing else.
 * @returns {{start: number, end: number, value: object}|null}
 */
function findRecord(message) {
  const start = message.search(/[{[]/);
  if (start === -1) return null;
  const end = matchingEnd(message, start);
  if (end === -1) return null;
  try {
    const value = JSON.parse(message.slice(start, end + 1));
    return isRecord(value) ? { start, end, value } : null;
  } catch {
    return null;
  }
}

/**
 * Adjacent pieces of the same kind are one token, not two. This is a rendering concern leaking
 * one level down on purpose: a token becomes an element, a record's punctuation alone is a dozen
 * of them per line, and at a two-thousand-line tail the browser's layout cost is the thing that
 * decides whether the log scrolls smoothly.
 */
const push = (tokens, kind, text) => {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) last.text += text;
  else tokens.push({ kind, text });
};

/**
 * A string, quoted and escaped the way JSON defines it — except that in Pretty a newline inside
 * one is printed as a newline. That stops the output being valid JSON, and it is the whole point:
 * an embedded stack trace is the one thing in a record that nobody can read escaped, and it is
 * the thing you opened the log to read.
 */
function writeString(value, tokens, pretty, depth, kind) {
  if (!pretty || !value.includes('\n')) {
    push(tokens, kind, JSON.stringify(value));
    return;
  }
  // Escaped a segment at a time: `JSON.stringify` on the whole string would turn the newlines into
  // `\n` before they could be broken on, and a blind replace afterwards would also hit a literal
  // backslash-n that was in the text to begin with.
  const pad = INDENT.repeat(depth + 1);
  const lines = value.split('\n').map((line) => JSON.stringify(line).slice(1, -1));
  push(tokens, kind, `"${lines.join(`\n${pad}`)}"`);
}

function writeEntries(tokens, pretty, depth, open, close, count, writeItem) {
  if (count === 0) {
    push(tokens, 'punct', `${open}${close}`);
    return;
  }
  const pad = pretty ? `\n${INDENT.repeat(depth + 1)}` : '';
  push(tokens, 'punct', `${open}${pad}`);
  for (let index = 0; index < count; index += 1) {
    if (index > 0) push(tokens, 'punct', `,${pad}`);
    writeItem(index);
  }
  push(tokens, 'punct', `${pretty ? `\n${INDENT.repeat(depth)}` : ''}${close}`);
}

function writeValue(value, tokens, pretty, depth, kind = 'string') {
  if (value === null) return push(tokens, 'literal', 'null');
  if (typeof value === 'boolean') return push(tokens, 'literal', String(value));
  if (typeof value === 'number') return push(tokens, 'number', String(value));
  if (typeof value === 'string') return writeString(value, tokens, pretty, depth, kind);

  if (Array.isArray(value)) {
    return writeEntries(tokens, pretty, depth, '[', ']', value.length, (index) =>
      writeValue(value[index], tokens, pretty, depth + 1)
    );
  }

  const entries = Object.entries(value);
  return writeEntries(tokens, pretty, depth, '{', '}', entries.length, (index) => {
    const [key, item] = entries[index];
    push(tokens, 'key', JSON.stringify(key));
    push(tokens, 'punct', pretty ? ': ' : ':');
    // A record's own level field is painted as the level it names, so a wall of records can be
    // skimmed down one column for the red ones.
    const level = LEVEL_KEYS.has(key.toLowerCase()) ? levelFrom(item) : null;
    writeValue(item, tokens, pretty, depth + 1, level ? `level-${level}` : 'string');
  });
}

/** Prose: the parts of a line worth telling apart when there is no structure to go on. */
function writeProse(text, tokens) {
  if (!text) return;
  let last = 0;
  PROSE.lastIndex = 0;
  for (let match = PROSE.exec(text); match; match = PROSE.exec(text)) {
    const [whole, url, quoted, level] = match;
    push(tokens, 'text', text.slice(last, match.index));
    if (url) push(tokens, 'url', whole);
    else if (quoted) push(tokens, 'string', whole);
    else if (level) push(tokens, `level-${LEVELS.get(level.toLowerCase()) ?? 'info'}`, whole);
    else push(tokens, 'number', whole);
    last = match.index + whole.length;
  }
  push(tokens, 'text', text.slice(last));
}

/**
 * @typedef {{kind: string, text: string}} Token `kind` names what the piece is — key, string,
 *   number, literal, punct, url, text, or `level-` and one of error/warn/info/debug.
 */

/**
 * One line, ready to paint.
 * @param {string} message
 * @param {boolean} pretty print a record over several lines, and unescape the strings in it
 * @returns {{level: string|null, tokens: Token[]}} `level` is what the line reports, for tinting
 *   the whole of it; it is null unless the line genuinely states one.
 */
export function highlight(message, pretty = false) {
  if (message.length > MAX_HIGHLIGHT_CHARS) return { level: null, tokens: [] };

  const tokens = [];
  const record = findRecord(message);
  if (!record) {
    writeProse(message, tokens);
    return { level: proseLevel(message), tokens };
  }

  const before = message.slice(0, record.start);
  writeProse(before, tokens);
  writeValue(record.value, tokens, pretty, 0);
  writeProse(message.slice(record.end + 1), tokens);
  // The prose fallback reads only what came before the record: a level word inside the record has
  // already had its say, and one in a message field is being quoted, not reported.
  return { level: recordLevel(record.value) ?? proseLevel(before), tokens };
}
