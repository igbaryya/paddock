/**
 * One terminal: an xterm.js screen bound to one session on the manager.
 *
 * The session lives on the server, not in here. This component attaches to one, replays what it
 * missed and streams the rest — so a reload, or switching to another tab and back, reattaches to
 * the same shell rather than starting a new one. That is also why `active` exists: the panel keeps
 * every terminal mounted so none of them loses its screen, and a hidden element has no size, so
 * fitting and focusing have to wait until this one is the one being looked at.
 *
 * Output arrives over SSE and input goes back as POSTs. The asymmetry is deliberate — see
 * `http/terminal-stream.js` — and costs nothing on loopback.
 */
import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { resizeTerminal, terminalStreamUrl, writeTerminal } from '../api.js';
import { useTheme } from '../useTheme.js';

/** Long enough to cover a drag of the window edge, short enough to feel like it followed it. */
const RESIZE_DEBOUNCE_MS = 120;

/**
 * The screen's colours, read from the same tokens every other surface uses rather than written
 * again here — xterm paints its own cells and cannot read a CSS variable from inside them.
 */
function readTheme() {
  const styles = getComputedStyle(document.documentElement);
  const token = (name) => styles.getPropertyValue(name).trim();
  return {
    background: token('--terminal'),
    foreground: token('--text'),
    cursor: token('--accent'),
    cursorAccent: token('--terminal'),
    selectionBackground: token('--accent-soft'),
  };
}

/**
 * @param {{sessionId: string, active: boolean, onExit: (event: {exitCode: number|null}) => void,
 *          onGone: () => void}} props
 *   `onGone` is the session no longer existing on the manager — a terminal reaped for being idle,
 *   or one closed from another dashboard; the panel drops the tab rather than showing a dead one
 */
export default function Terminal({ sessionId, active, onExit, onGone }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const { resolved } = useTheme();

  // Read through refs: the panel passes fresh arrows every render, and depending on them would
  // tear down the terminal and its stream on every parent render.
  const callbacks = useRef({ onExit, onGone });
  callbacks.current = { onExit, onGone };

  useEffect(() => {
    const term = new XTerm({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(),
      fontSize: 12.5,
      // The server keeps its own scrollback for replay; this is what the user can scroll back
      // through in the browser, and it is cheap because it is only ever this one screen's worth.
      scrollback: 5_000,
      theme: readTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;

    // The geometry the server is told about, so a fit that changed nothing sends nothing.
    let sent = { cols: 0, rows: 0 };
    let resizeTimer = null;
    const pushSize = () => {
      const { cols, rows } = term;
      if (cols === sent.cols && rows === sent.rows) return;
      sent = { cols, rows };
      resizeTerminal(sessionId, cols, rows).catch(() => {
        // The session has gone; the stream's exit frame is what explains that, not a failed resize.
      });
    };
    term.onResize(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(pushSize, RESIZE_DEBOUNCE_MS);
    });

    const input = term.onData((data) => {
      writeTerminal(sessionId, data).catch(() => {});
    });

    // Fires for the container and for the element becoming visible again, which is the tab switch.
    const observer = new ResizeObserver(() => {
      if (hostRef.current?.clientWidth > 0) fit.fit();
    });
    observer.observe(hostRef.current);

    const stream = new EventSource(terminalStreamUrl(sessionId));
    stream.addEventListener('data', (event) => {
      term.write(JSON.parse(event.data).chunk);
    });
    stream.addEventListener('exit', (event) => {
      const { exitCode } = JSON.parse(event.data);
      // Written into the screen as well as reported upward: the tab says the session ended, and
      // this says it in the place the user was actually looking.
      term.write(`\r\n\x1b[2m[the shell exited${exitCode === null ? '' : ` with code ${exitCode}`}]\x1b[0m\r\n`);
      stream.close();
      callbacks.current.onExit({ exitCode });
    });
    stream.onerror = () => {
      // EventSource retries by itself and only reports the attempt, so a closed connection here is
      // either a reconnect in progress or a session the manager no longer has. Only the second is
      // final, and the readyState is what tells them apart.
      if (stream.readyState === EventSource.CLOSED) callbacks.current.onGone();
    };

    return () => {
      clearTimeout(resizeTimer);
      observer.disconnect();
      input.dispose();
      stream.close();
      term.dispose();
    };
    // The session is the identity of this terminal: a different one is a different screen, and
    // nothing else here should ever rebuild it.
  }, [sessionId]);

  // The theme is a repaint, not a rebuild — switching to light must not clear anyone's scrollback.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = readTheme();
  }, [resolved]);

  useEffect(() => {
    if (!active) return;
    // A hidden element has no size, so the fit that mattered is this one: the tab was just shown.
    fitRef.current?.fit();
    termRef.current?.focus();
  }, [active]);

  return <div className="terminal-screen" ref={hostRef} />;
}
