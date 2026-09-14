/**
 * Chunks to lines, for anything that reads text in pieces the OS chose: a child's stdout pipe, or
 * a log file read from the offset last seen. A chunk boundary lands mid-line all the time, and the
 * last line before a stream ends usually has no newline at all.
 */

const LINE_BREAK = /\r\n|\n|\r/;

/**
 * Holds back a trailing lone `\r` until the next chunk, so a CRLF straddling a chunk boundary is not
 * torn into a bogus line plus an empty one (FINDINGS D3).
 */
export const createLineSplitter = () => {
  let residual = '';
  return {
    /** @param {string} chunk @returns {string[]} */
    push(chunk) {
      residual += chunk;
      const held = residual.endsWith('\r');
      const parts = (held ? residual.slice(0, -1) : residual).split(LINE_BREAK);
      residual = parts.pop() + (held ? '\r' : '');
      return parts;
    },
    /** @returns {string[]} whatever is left, so a final line without a newline is not lost */
    flush() {
      const rest = residual.endsWith('\r') ? residual.slice(0, -1) : residual;
      residual = '';
      return rest ? rest.split(LINE_BREAK) : [];
    },
  };
};
