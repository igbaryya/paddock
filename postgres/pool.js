/**
 * Connections to the servers PostgreSQL applications run. One pg.Pool per application and database,
 * created lazily and kept until the application is deleted or Paddock shuts down. Callers hand in a
 * resolved connection — this module never reads configuration — and every tool names its database,
 * so nothing here has an implicit target.
 *
 * A pool remembers the connection it was opened with. When an edit changes the port or the
 * credentials, the next call finds a mismatch and replaces the pool rather than quietly carrying on
 * against the old server.
 */
import pg from 'pg';
import { PG_CONNECT_TIMEOUT_MS, PG_STATEMENT_TIMEOUT_MS } from '../config.js';

/** int8 comes back as a string by default; row counts and byte sizes read better as numbers. */
pg.types.setTypeParser(20, (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : v));

/**
 * bytea is left in the text form the server sends (`\x0a1b…`), which is how psql shows it. pg's own
 * parser makes it a Buffer, and a Buffer serialises to JSON as an array of every byte.
 */
pg.types.setTypeParser(17, (v) => v);

/** @type {Map<string, {signature: string, pool: import('pg').Pool}>} keyed `applicationId:database` */
const pools = new Map();

const poolKey = (applicationId, database) => `${applicationId}:${database}`;

const signatureOf = ({ host, port, user, password }) => JSON.stringify([host, port, user, password]);

const endPool = (pool) => pool.end().catch(() => {});

function openPool(connection, database) {
  const pool = new pg.Pool({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    // Empty means none configured; undefined lets pg fall back to PGPASSWORD and ~/.pgpass.
    password: connection.password || undefined,
    database,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS,
    statement_timeout: PG_STATEMENT_TIMEOUT_MS,
    application_name: 'paddock',
  });
  // Required, or a dropped idle connection crashes Paddock. Not logged: stopping the server drops
  // every idle connection, and the pool replaces them on the next query anyway.
  pool.on('error', () => {});
  return pool;
}

/** @param {object} connection from `cluster.connectionOf` @param {string} database */
function getPool(connection, database) {
  const key = poolKey(connection.applicationId, database);
  const signature = signatureOf(connection);
  const existing = pools.get(key);
  if (existing?.signature === signature) return existing.pool;
  if (existing) endPool(existing.pool);
  const pool = openPool(connection, database);
  pools.set(key, { signature, pool });
  return pool;
}

/** pg returns an array of results for multi-statement queries; flatten to the shape tools return. */
function normalize(result) {
  const last = Array.isArray(result) ? result[result.length - 1] : result;
  return {
    command: Array.isArray(result) ? result.map((r) => r.command).join(', ') : result.command,
    rowCount: last?.rowCount ?? 0,
    columns: (last?.fields ?? []).map((f) => f.name),
    rows: last?.rows ?? [],
  };
}

/**
 * The query as pg takes it. Without values pg uses the simple protocol, which is what allows several
 * `;`-separated statements in one call; `extended` forces the protocol that accepts exactly one.
 * @param {{rowMode?: 'array', queryMode?: 'extended'}} options `array` rows keep two columns that
 *   share a name — a join's two `id`s — apart, where row objects would silently keep only the last
 */
const queryOf = (sql, params, { rowMode, queryMode } = {}) => ({
  text: sql,
  ...(params?.length ? { values: params } : {}),
  ...(rowMode ? { rowMode } : {}),
  ...(queryMode ? { queryMode } : {}),
});

/**
 * Run SQL with no wrapping transaction — writes and DDL land for real.
 * @param {object} connection @param {string} database @param {string} sql @param {unknown[]} [params]
 * @param {{rowMode?: 'array'}} [options]
 */
export async function runSql(connection, database, sql, params, options) {
  const client = await getPool(connection, database).connect();
  try {
    return normalize(await client.query(queryOf(sql, params, options)));
  } finally {
    client.release();
  }
}

/**
 * Run one statement inside a READ ONLY transaction — the server itself rejects any write, so there is
 * no SQL parsing to get wrong. Always rolled back.
 *
 * One statement, enforced by the extended protocol: over the simple one, `COMMIT; DELETE …` ends the
 * read-only transaction and the DELETE runs committed after it. Measured, not assumed — it wrote.
 * @param {object} connection @param {string} database @param {string} sql @param {unknown[]} [params]
 * @param {{rowMode?: 'array'}} [options]
 */
export async function runReadOnlySql(connection, database, sql, params, options) {
  const client = await getPool(connection, database).connect();
  try {
    await client.query('BEGIN READ ONLY');
    return normalize(await client.query(queryOf(sql, params, { ...options, queryMode: 'extended' })));
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/** Cluster-level SQL, against the connection's maintenance database. */
export function runMaintenanceSql(connection, sql, params) {
  return runSql(connection, connection.maintenanceDatabase, sql, params);
}

/** Drop our own pool for a database — required before DROP DATABASE, which refuses live sessions. */
export async function closeDatabasePool(connection, database) {
  const key = poolKey(connection.applicationId, database);
  const existing = pools.get(key);
  if (!existing) return;
  pools.delete(key);
  await endPool(existing.pool);
}

/** A deleted application's pools, or they would hold connections to a server nobody can reach. */
export async function closeApplication(applicationId) {
  const prefix = poolKey(applicationId, '');
  const closing = [...pools].filter(([key]) => key.startsWith(prefix));
  for (const [key] of closing) pools.delete(key);
  await Promise.all(closing.map(([, { pool }]) => endPool(pool)));
}

/** Shutdown: close every pool before the servers they point at are stopped. */
export async function closeAll() {
  const closing = [...pools.values()];
  pools.clear();
  await Promise.all(closing.map(({ pool }) => endPool(pool)));
}
