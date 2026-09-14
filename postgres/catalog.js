/**
 * Catalog introspection — everything an agent needs to orient itself in a database before it
 * writes a query. All reads go through the read-only path.
 */
import { runReadOnlySql, runMaintenanceSql } from './pool.js';
import { targetOf } from './cluster.js';

const USER_SCHEMAS = "n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'";

/** @param {object} connection @param {boolean} includeTemplates */
export async function listDatabases(connection, includeTemplates) {
  const { rows } = await runMaintenanceSql(
    connection,
    `SELECT d.datname AS name,
            pg_get_userbyid(d.datdba) AS owner,
            pg_encoding_to_char(d.encoding) AS encoding,
            d.datistemplate AS is_template,
            d.datallowconn AS allows_connections,
            pg_size_pretty(pg_database_size(d.datname)) AS size,
            (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname) AS connections
       FROM pg_database d
      WHERE $1::bool OR NOT d.datistemplate
      ORDER BY d.datname`,
    [includeTemplates]
  );
  return rows;
}

/** @param {object} connection @param {string} database */
export async function listSchemas(connection, database) {
  const { rows } = await runReadOnlySql(
    connection,
    database,
    `SELECT n.nspname AS schema,
            pg_get_userbyid(n.nspowner) AS owner,
            (SELECT count(*) FROM pg_class c
              WHERE c.relnamespace = n.oid AND c.relkind IN ('r','p','v','m')) AS relations
       FROM pg_namespace n
      WHERE ${USER_SCHEMAS}
      ORDER BY 1`
  );
  return rows;
}

/**
 * @param {object} connection
 * @param {string} database
 * @param {string} [schema] restrict to one schema; omitted means every user schema
 */
export async function listTables(connection, database, schema) {
  const { rows } = await runReadOnlySql(
    connection,
    database,
    `SELECT n.nspname AS schema,
            c.relname AS name,
            CASE c.relkind
              WHEN 'r' THEN 'table'
              WHEN 'p' THEN 'partitioned table'
              WHEN 'v' THEN 'view'
              WHEN 'm' THEN 'materialized view'
              WHEN 'f' THEN 'foreign table'
            END AS kind,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows,
            pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
            obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p','v','m','f')
        AND ${USER_SCHEMAS}
        AND ($1::text IS NULL OR n.nspname = $1)
      ORDER BY 1, 2`,
    [schema ?? null]
  );
  return rows;
}

/**
 * Columns, indexes, constraints and incoming foreign keys for one relation.
 * `table` may be schema-qualified ("app.users"); unqualified names resolve through search_path.
 * @param {object} connection
 * @param {string} database
 * @param {string} table
 */
export async function describeTable(connection, database, table) {
  const read = (sql) => runReadOnlySql(connection, database, sql, [table]);
  const [columns, indexes, constraints, referencedBy] = await Promise.all([
    read(
      `SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS "default",
              a.attidentity <> '' OR a.attgenerated <> '' AS generated,
              col_description(a.attrelid, a.attnum) AS comment
         FROM pg_attribute a
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`
    ),
    read(
      `SELECT c.relname AS name,
              i.indisprimary AS is_primary,
              i.indisunique AS is_unique,
              pg_get_indexdef(i.indexrelid) AS definition
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = $1::regclass
        ORDER BY 1`
    ),
    read(
      `SELECT conname AS name,
              CASE contype
                WHEN 'p' THEN 'primary key'
                WHEN 'f' THEN 'foreign key'
                WHEN 'u' THEN 'unique'
                WHEN 'c' THEN 'check'
                ELSE contype::text
              END AS type,
              pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = $1::regclass
        ORDER BY contype, conname`
    ),
    read(
      `SELECT conrelid::regclass::text AS "table",
              conname AS name,
              pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE confrelid = $1::regclass AND contype = 'f'
        ORDER BY 1, 2`
    ),
  ]);

  return {
    database,
    table,
    columns: columns.rows,
    indexes: indexes.rows,
    constraints: constraints.rows,
    referenced_by: referencedBy.rows,
  };
}

/** Cluster health + where the connection points — the "is the DB up?" answer. */
export async function clusterInfo(connection) {
  const { rows } = await runMaintenanceSql(
    connection,
    `SELECT current_setting('server_version') AS server_version,
            version() AS version_full,
            pg_postmaster_start_time() AS started_at,
            current_user AS connected_as,
            current_setting('data_directory') AS data_directory,
            (SELECT count(*) FROM pg_database WHERE NOT datistemplate) AS databases,
            (SELECT count(*) FROM pg_stat_activity) AS connections`
  );
  return { ...targetOf(connection), maintenance_database: connection.maintenanceDatabase, ...rows[0] };
}
