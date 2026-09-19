/**
 * MCP installation preferences — stored in the main JSON document under `preferences.mcp`.
 *
 * The port is chosen once in the setup wizard and kept here rather than in `.env`, so the dashboard
 * can show and change it without asking the user to edit files. Env `PADDOCK_MCP_PORT` still wins
 * when set, the same way `PADDOCK_PORT` wins over everything else for the UI.
 */
import { DISPLAY_HOST } from './config.js';
import * as db from './json-db.js';

export const DEFAULT_MCP_PORT = 4600;
export const MAX_AUDIT = 50;

const MIN_PORT = 1024;
const MAX_PORT = 65_535;

/** @typedef {{port: number|null, configured: boolean, enabled: boolean,
 *            lastStartedAt: string|null, lastStoppedAt: string|null,
 *            audit: {at: string, action: string, detail: string|null}[]}} McpPreferences */

/** @returns {McpPreferences} */
export const defaultMcp = () => ({
  port: null,
  configured: false,
  enabled: false,
  lastStartedAt: null,
  lastStoppedAt: null,
  audit: [],
});

/** @param {number} port */
export function validatePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    throw new TypeError(`MCP port must be an integer from ${MIN_PORT} to ${MAX_PORT}`);
  }
  return value;
}

/** @returns {Promise<McpPreferences>} */
export async function read() {
  const doc = await db.read();
  return { ...defaultMcp(), ...(doc.preferences?.mcp ?? {}) };
}

/**
 * @param {(current: McpPreferences) => McpPreferences} mutate
 * @returns {Promise<McpPreferences>}
 */
export async function update(mutate) {
  await db.update((doc) => {
    const current = { ...defaultMcp(), ...(doc.preferences?.mcp ?? {}) };
    const next = mutate(structuredClone(current));
    return {
      ...doc,
      preferences: {
        ...(doc.preferences ?? {}),
        mcp: next,
      },
    };
  });
  return read();
}

/**
 * @param {McpPreferences} prefs
 * @param {string} action
 * @param {string|null} [detail]
 */
export function appendAudit(prefs, action, detail = null) {
  const entry = { at: new Date().toISOString(), action, detail };
  prefs.audit = [entry, ...prefs.audit].slice(0, MAX_AUDIT);
}

/** @param {number|null} port */
export function mcpUrl(port) {
  return port ? `http://${DISPLAY_HOST}:${port}/mcp` : null;
}
