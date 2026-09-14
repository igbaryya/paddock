/**
 * A PostgreSQL application as the rest of Paddock sees it: one server, where its files are, and
 * where to connect. Everything here is derived from the application's `postgres` settings on every
 * read and never stored, so the settings stay the only source of truth.
 *
 * The server is not a child of Paddock. pg_ctl daemonises it into a session of its own, so it keeps
 * running when Paddock stops, restarts or crashes — and may already be running when Paddock comes up.
 */
import path from 'node:path';
import { LOG_DIR } from '../config.js';

/** Every PostgreSQL application has exactly one server, so its id can be a word an agent reads. */
export const SERVER_PROCESS_ID = 'postgres';

/** Paddock only runs clusters on this machine, and it only ever connects to them over loopback. */
export const HOST = 'localhost';

/**
 * Where the server writes its log: the configured file, or one of Paddock's own beside the logs of
 * the application's processes. Kept outside the data directory, where a stray file would be copied
 * along by every base backup of the cluster.
 * @param {import('../applications.js').ApplicationConfig} config a `postgres` application
 */
const logFileOf = (config) =>
  config.postgres.logFile ?? path.join(LOG_DIR, config.id, 'postgresql.log');

/** @param {string|null} binDirectory null runs whichever pg_ctl the PATH resolves */
const pgCtlOf = (binDirectory) => (binDirectory ? path.join(binDirectory, 'pg_ctl') : 'pg_ctl');

/**
 * What postgres/lifecycle.js needs to start, stop and observe the server.
 * @param {import('../applications.js').ApplicationConfig} config a `postgres` application
 */
export const serverOf = (config) => ({
  applicationId: config.id,
  dataDirectory: config.postgres.dataDirectory,
  port: config.postgres.port,
  pgCtl: pgCtlOf(config.postgres.binDirectory),
  logFile: logFileOf(config),
});

/**
 * The server as a process row, so views, logs and ports treat it like any other process. `command`
 * is what Paddock runs to start it — shown, never executed from here.
 * @param {import('../applications.js').ApplicationConfig} config a `postgres` application
 */
export const serverProcess = (config) => {
  const server = serverOf(config);
  return {
    id: SERVER_PROCESS_ID,
    name: SERVER_PROCESS_ID,
    repositoryPath: server.dataDirectory,
    command: `${server.pgCtl} start -D ${server.dataDirectory} -l ${server.logFile} -o "-p ${server.port}"`,
    workingDirectory: null,
    env: {},
    enabled: true,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
};

/**
 * Where the database tools connect. A server already running answers on the port its postmaster.pid
 * says, which is not necessarily the configured one when something other than Paddock started it.
 * Carries the application id because pools are per application, and the password because the pool
 * needs it — this object never reaches a view.
 * @param {import('../applications.js').ApplicationConfig} config a `postgres` application
 * @param {{port: number|null}} state the server's observed state
 */
export const connectionOf = (config, state) => ({
  applicationId: config.id,
  host: HOST,
  port: state.port ?? config.postgres.port,
  user: config.postgres.user,
  password: config.postgres.password,
  maintenanceDatabase: config.postgres.maintenanceDatabase,
});

/** Where a connection points, without its password. */
export const targetOf = (connection) => ({
  host: connection.host,
  port: connection.port,
  user: connection.user,
});
