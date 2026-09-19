/**
 * One terminal's output, streamed to the one dashboard watching it.
 *
 * Not part of the hub in `events.js`, and the difference is the point. The hub is a broadcast: the
 * same status and the same log line go to every open dashboard, batched, because nothing there
 * belongs to a particular client. A terminal is the opposite — the bytes are an answer to what
 * *this* person typed, they arrive at whatever rate the command sets, and they open with a replay
 * of the screen that only a newly-attached client should be sent. Sharing the hub would mean
 * every dashboard repainting every terminal.
 *
 * Only the output comes this way. Keystrokes go back as POSTs to `/api/terminals/:id/input`, which
 * keeps them inside the `/api` surface the local-origin guard in `server.js` already covers,
 * rather than needing a second guard on a socket upgrade.
 *
 * Frames:
 *   `data`  `{chunk}` — raw terminal output, escape sequences and all
 *   `exit`  `{exitCode, signal}` — the shell is gone; nothing further will arrive
 */
import * as sse from './sse.js';
import * as service from '../service.js';
import { errorMessage, httpErrorStatus, json } from './respond.js';

/** `/api/terminals/<id>/stream`, with the id as the capture. */
export const STREAM_PATH = /^\/api\/terminals\/([^/]+)\/stream$/;

const CODE_BY_STATUS = { 404: 'not_found', 400: 'validation_error' };

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} sessionId as captured from the path, so still percent-encoded
 */
export function handleTerminalStream(req, res, sessionId) {
  if (sse.rejectNonGet(req, res)) return;
  const id = decodeURIComponent(sessionId);

  // Resolved before a single header goes out. Subscribing first is not an option — the subscription
  // replays the session's scrollback synchronously, and a stream that has not opened yet would
  // drop every byte of it — so an unknown terminal has to be turned away here or not at all.
  try {
    service.getTerminal(id);
  } catch (err) {
    const status = httpErrorStatus(err);
    json(res, status, {
      error: { message: errorMessage(err), code: CODE_BY_STATUS[status] ?? 'internal_error' },
    });
    return;
  }

  let unsubscribe = null;
  sse.open(res, () => unsubscribe?.());

  try {
    unsubscribe = service.followTerminal(id, {
      onData: (chunk) => sse.send(res, 'data', { chunk }),
      // Ended rather than left open: `EventSource` reconnects by itself, and reconnecting to a
      // session that has finished would poll a 404 every few seconds for as long as the tab lives.
      onExit: (event) => {
        sse.send(res, 'exit', { exitCode: event.exitCode ?? null, signal: event.signal ?? null });
        sse.end(res);
      },
    });
  } catch {
    // The session ended in the moment between the check above and this subscription. The stream is
    // already open, so the only answer left is to close it — which the client reads as a terminal
    // that is gone, because it is.
    sse.end(res);
  }
}
