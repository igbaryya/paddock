/**
 * The SQL console of a PostgreSQL application: pick a database, write SQL, see what came back.
 *
 * Reads by default. A run goes to the server inside a READ ONLY transaction — one statement, which
 * the manager enforces — unless "Allow writes" is ticked: the same line the agent's `query` and
 * `execute` tools draw, so nothing typed here by accident changes data.
 *
 * ⌘/Ctrl+Enter runs the selection when there is one and the whole editor otherwise, the gesture
 * every database tool has already taught. Rows are drawn exactly as the manager sent them — as
 * arrays beside their column names — so a join's two `id` columns stay two columns.
 */
import { useEffect, useRef, useState } from 'react';
import * as api from '../api.js';
import Icon from './Icon.jsx';
import IconButton from './IconButton.jsx';
import Switch from './Switch.jsx';

/** A text value this long is cut in its cell; the whole of it is on the cell's tooltip. */
const MAX_CELL_CHARS = 200;

/**
 * The databases on the server, fetched again whenever it comes up and on demand. None while it is
 * down — there is nothing to ask.
 * @param {object} application
 */
function useDatabases(application) {
  const running = application.status === 'running';
  const [databases, setDatabases] = useState(null);
  const [error, setError] = useState(null);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    setDatabases(null);
    setError(null);
    if (!running) return undefined;
    const controller = new AbortController();
    api
      .listDatabases(application.id, controller.signal)
      .then((rows) => setDatabases(rows.filter((row) => row.allows_connections)))
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [application.id, running, epoch]);

  return { running, databases, error, reload: () => setEpoch((n) => n + 1) };
}

/** The selected text of the editor, or all of it when nothing is selected. */
const statementOf = (editor) => {
  const { selectionStart, selectionEnd, value } = editor;
  const selected = value.slice(selectionStart, selectionEnd);
  return selected.trim() ? selected : value;
};

/** JSON and arrays are objects by the time they arrive; everything else reads as its own text. */
function cellText(value) {
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** @param {{value: unknown}} props */
function Cell({ value }) {
  if (value === null) return <td className="sql-null">NULL</td>;
  const text = cellText(value);
  const cut = text.length > MAX_CELL_CHARS;
  return (
    <td className={typeof value === 'number' ? 'sql-number' : undefined} title={cut ? text : undefined}>
      {cut ? `${text.slice(0, MAX_CELL_CHARS)}…` : text}
    </td>
  );
}

/** @param {{result: object}} props */
function ResultGrid({ result }) {
  const summary = result.columns.length
    ? `${result.rowCount} ${result.rowCount === 1 ? 'row' : 'rows'}`
    : `${result.rowCount} affected`;

  return (
    <>
      <p className="sql-summary meta">
        <span className="mono">{result.command}</span> · {summary} · {result.durationMs} ms
        {result.truncated && ` · showing the first ${result.rows.length} — add a LIMIT`}
      </p>
      {result.columns.length > 0 && (
        <div className="sql-results">
          <table className="sql-table">
            <thead>
              <tr>
                <th className="sql-row-number" aria-label="Row" />
                {result.columns.map((column, index) => (
                  // Index-keyed on purpose: two columns may share a name, and each is its own column.
                  <th key={index}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <td className="sql-row-number">{rowIndex + 1}</td>
                  {row.map((value, index) => (
                    <Cell key={index} value={value} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * The line a PostgreSQL error points at, with a caret under the character. `position` is 1-based
 * and counts characters of the statement that ran — the selection, when that is what ran.
 * @returns {{line: number, text: string, caret: string}|null}
 */
function pointerOf(statement, position) {
  const index = Number(position) - 1;
  if (!statement || !Number.isInteger(index) || index < 0 || index > statement.length) return null;
  const before = statement.slice(0, index);
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = statement.indexOf('\n', index);
  return {
    line: before.split('\n').length,
    text: statement.slice(lineStart, lineEnd === -1 ? undefined : lineEnd),
    caret: `${' '.repeat(index - lineStart)}^`,
  };
}

/** @param {{error: object, statement: string}} props an ApiError, and the SQL that produced it */
function SqlError({ error, statement }) {
  const database = error.database;
  const pointer = database?.position ? pointerOf(statement, database.position) : null;
  return (
    <div className="notice danger sql-error" role="alert">
      <Icon name="alert" />
      <div className="sql-error-body">
        <p>{error.message}</p>
        {pointer && (
          <pre className="sql-pointer">
            {`line ${pointer.line}: ${pointer.text}\n${' '.repeat(`line ${pointer.line}: `.length)}${pointer.caret}`}
          </pre>
        )}
        {database?.detail && <p className="hint">Detail: {database.detail}</p>}
        {database?.hint && <p className="hint">Hint: {database.hint}</p>}
        {database?.code && <p className="hint">SQLSTATE {database.code}</p>}
      </div>
    </div>
  );
}

/** @param {{application: object}} props a PostgreSQL application's view */
export default function SqlConsole({ application }) {
  const { running, databases, error: listError, reload } = useDatabases(application);
  const [database, setDatabase] = useState('');
  const [sql, setSql] = useState('');
  const [allowWrites, setAllowWrites] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [pending, setPending] = useState(false);
  const editorRef = useRef(null);

  // The maintenance database is where the server is known to accept a connection, so it is the
  // first choice; a database that disappeared (dropped from here, say) gives way to it too.
  const names = databases?.map((row) => row.name) ?? [];
  const fallback = names.includes(application.postgres.maintenanceDatabase)
    ? application.postgres.maintenanceDatabase
    : names[0] ?? '';
  const selected = names.includes(database) ? database : fallback;

  const run = async () => {
    const statement = statementOf(editorRef.current);
    if (!statement.trim() || !selected || pending) return;
    setPending(true);
    try {
      const result = await api.runStatement(application.id, {
        database: selected,
        sql: statement,
        readOnly: !allowWrites,
      });
      setOutcome({ result, statement });
      // A write may have created or dropped a database; the list is cheap to ask for again.
      if (allowWrites) reload();
    } catch (err) {
      setOutcome({ error: err, statement });
    } finally {
      setPending(false);
    }
  };

  const onKeyDown = (event) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    run();
  };

  return (
    <section className="panel sql-console" aria-label="SQL console">
      <div className="panel-head">
        <h2 className="panel-title">
          <Icon name="database" />
          SQL
        </h2>
        <select
          className="select"
          aria-label="Database"
          value={selected}
          disabled={!databases?.length}
          onChange={(event) => setDatabase(event.target.value)}
        >
          {names.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <IconButton
          icon="refresh"
          label="Reload databases"
          className="small ghost"
          disabled={!running}
          onClick={reload}
        />
        <span className="spacer" />
        <Switch checked={allowWrites} label="Allow writes" onChange={setAllowWrites}>
          Allow writes
        </Switch>
        <button
          type="button"
          className={`btn small ${allowWrites ? 'danger' : 'primary'}`}
          disabled={!running || !selected || pending || !sql.trim()}
          onClick={run}
        >
          <Icon name="play" />
          {pending ? 'Running…' : 'Run'}
        </button>
      </div>

      {!running && (
        <p className="panel-note">The server is {application.status}. Start it to run queries.</p>
      )}
      {listError && <p className="notice danger">{listError}</p>}

      <textarea
        ref={editorRef}
        className="sql-editor"
        value={sql}
        onChange={(event) => setSql(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="SELECT * FROM pg_stat_activity LIMIT 20;"
        spellCheck={false}
        aria-label="SQL"
        rows={8}
      />
      <p className="panel-foot meta">
        {allowWrites ? 'Writes are committed as they run.' : 'Read-only, one statement at a time.'}{' '}
        ⌘/Ctrl+Enter runs the selection, or everything when nothing is selected.
      </p>

      {outcome?.error && <SqlError error={outcome.error} statement={outcome.statement} />}
      {outcome?.result && <ResultGrid result={outcome.result} />}
    </section>
  );
}
