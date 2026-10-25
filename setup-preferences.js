/**
 * First-run setup — stored in the main JSON document under `preferences.setup`, beside MCP's.
 *
 * One fact: when the setup wizard was last finished or skipped. Either ends it — it does not open by
 * itself again, in this browser or another — and Settings is where it is opened after that.
 */
import * as db from './json-db.js';

/** @typedef {{completedAt: string|null}} SetupPreferences */

/** @returns {SetupPreferences} */
const defaultSetup = () => ({ completedAt: null });

/** @returns {Promise<SetupPreferences>} */
export async function read() {
  const doc = await db.read();
  return { ...defaultSetup(), ...(doc.preferences?.setup ?? {}) };
}

/** @returns {Promise<SetupPreferences>} */
export async function complete() {
  await db.update((doc) => ({
    ...doc,
    preferences: {
      ...(doc.preferences ?? {}),
      setup: { completedAt: new Date().toISOString() },
    },
  }));
  return read();
}
