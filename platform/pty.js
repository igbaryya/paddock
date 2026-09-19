/**
 * The pseudo-terminal binding, and the only place node-pty is named.
 *
 * A pty is what separates a terminal from a pipe: without a controlling tty a shell prints no
 * prompt, emits no colour, and refuses to run anything interactive. There is no way to get one
 * from Node alone, so this is the manager's one native dependency.
 *
 * It is loaded lazily and never at import time. A native binding is compiled against a single Node
 * ABI, and this server runs under two — the `node` of a checkout, and Electron's inside the desktop
 * app's utility process. Loading the wrong one throws, and a static import would take the whole
 * manager down over a feature nothing else depends on. So the failure is caught here and reported
 * as `available: false` with the loader's own words, exactly as a missing folder dialog is.
 */

/** @type {Promise<{module: object|null, reason: string|null}>|null} */
let loaded = null;

/**
 * Resolved once, whatever the outcome: a binding that failed to load will fail identically every
 * time, and retrying it per session would pay the same cost to learn the same thing.
 */
const load = () =>
  (loaded ??= import('node-pty').then(
    (module) => ({ module, reason: null }),
    (err) => ({ module: null, reason: err.message })
  ));

/**
 * Whether this copy can open a terminal at all, and why not when it cannot. Never throws: the
 * dashboard asks this to decide between showing a terminal and explaining its absence.
 * @returns {Promise<{available: boolean, reason: string|null}>}
 */
export async function availability() {
  const { module, reason } = await load();
  return { available: module !== null, reason };
}

/**
 * @typedef {{pid: number, onData: (listener: (chunk: string) => void) => void,
 *            onExit: (listener: (event: {exitCode: number, signal?: number}) => void) => void,
 *            write: (data: string) => void, resize: (cols: number, rows: number) => void,
 *            destroy: () => void}} PtyHandle
 */

/**
 * Open a pty running `file`. The shell is the caller's — this module knows how to hold a terminal
 * open, not which one this OS uses.
 *
 * `encoding: 'utf8'` is what makes `onData` deliver strings that are safe to forward: node-pty
 * holds a decoder across reads, so a multi-byte character split across two reads from the master
 * arrives whole instead of as two replacement characters.
 *
 * @param {{file: string, args: string[], cwd: string, env: Record<string, string>,
 *          cols: number, rows: number}} request
 * @returns {Promise<PtyHandle>}
 * @throws when the binding is unavailable — callers check `availability()` first and report that
 *   rather than letting this surface as an internal error
 */
export async function open({ file, args, cwd, env, cols, rows }) {
  const { module, reason } = await load();
  if (!module) throw new Error(`no pseudo-terminal support on this installation: ${reason}`);
  const child = module.spawn(file, args, {
    // What the shell and everything it runs read out of TERM. 256 colours is the floor every
    // modern prompt assumes, and xterm.js renders the whole of it.
    name: 'xterm-256color',
    cwd,
    env,
    cols,
    rows,
    encoding: 'utf8',
  });
  return {
    pid: child.pid,
    onData: (listener) => child.onData(listener),
    onExit: (listener) => child.onExit(listener),
    write: (data) => child.write(data),
    resize: (nextCols, nextRows) => child.resize(nextCols, nextRows),
    // Closing the master is what sends SIGHUP to everything still attached to the tty, which is how
    // a shell's own children go down with it. Guarded: a pty whose shell has already exited throws.
    destroy: () => {
      try {
        child.kill();
      } catch {
        // Already gone. The session is being discarded either way.
      }
    },
  };
}
