/**
 * Cluster administration — CREATE / DROP DATABASE. These cannot run inside a transaction and are
 * not parameterizable, so identifiers are validated and quoted here rather than bound.
 */
import { runMaintenanceSql, closeDatabasePool } from './pool.js';
import { ValidationError } from '../applications.js';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Dropping any of these breaks the cluster. */
const ALWAYS_PROTECTED = ['postgres', 'template0', 'template1'];

/** @param {string} name @param {string} label */
function assertIdent(name, label) {
  if (typeof name !== 'string' || !IDENT_RE.test(name) || name.length > 63) {
    throw new ValidationError(
      `Invalid ${label} "${name}" — must match ${IDENT_RE.source} and be at most 63 characters.`
    );
  }
}

const quoteIdent = (name) => `"${name.replace(/"/g, '""')}"`;

/**
 * @param {object} connection
 * @param {{ name: string; owner?: string; template?: string }} opts
 */
export async function createDatabase(connection, { name, owner, template }) {
  assertIdent(name, 'database name');
  if (owner) assertIdent(owner, 'owner');
  if (template) assertIdent(template, 'template');

  const options = [
    owner ? `OWNER ${quoteIdent(owner)}` : null,
    template ? `TEMPLATE ${quoteIdent(template)}` : null,
  ].filter(Boolean);

  const sql = `CREATE DATABASE ${quoteIdent(name)}${options.length ? ` WITH ${options.join(' ')}` : ''}`;
  await runMaintenanceSql(connection, sql);
  return { created: name, sql };
}

/**
 * FORCE terminates other sessions on the target (PG13+); our own pool is closed first because
 * the terminating backend cannot be connected to the database it drops.
 * @param {object} connection
 * @param {{ name: string }} opts
 */
export async function dropDatabase(connection, { name }) {
  assertIdent(name, 'database name');
  if ([...ALWAYS_PROTECTED, connection.maintenanceDatabase].includes(name)) {
    throw new ValidationError(`Refusing to drop protected database "${name}".`);
  }

  await closeDatabasePool(connection, name);
  const sql = `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`;
  await runMaintenanceSql(connection, sql);
  return { dropped: name, sql };
}
