/**
 * Configuration domain — the only place that decides what a valid Application and Process look
 * like. It owns validation, normalisation and id generation, and knows nothing about running
 * processes: everything here is pure config that survives a restart. Reads go through
 * `json-db.read()`; every mutation runs inside `json-db.update()` so the "is this name taken?"
 * check and the write it guards cannot be split by a concurrent request.
 */
import { randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { read, update } from './json-db.js';

/**
 * @typedef {{id: string, name: string, repositoryPath: string, command: string,
 *            workingDirectory: string|null, env: Record<string, string>, enabled: boolean,
 *            createdAt: string, updatedAt: string}} ProcessConfig
 */
/**
 * @typedef {{id: string, name: string, description: string, processes: ProcessConfig[],
 *            createdAt: string, updatedAt: string}} ApplicationConfig
 */

/** Bad input from a user or an agent — the HTTP layer turns this into a 400. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION_ERROR';
  }
}

/** A referenced application or process is not in the DB — a 404, never a 500. */
export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
  }
}

const MAX_NAME_LENGTH = 80;
const MAX_COMMAND_LENGTH = 2_000;
const MAX_QUOTED_LENGTH = 200;
/** Exported for `workspace.js`: a variable it reads out of a .env and this module would then refuse
 * is not a variable the form should be offering to fill in. */
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_RADIX = ID_ALPHABET.length;
const ID_LENGTH = 12;
// 256 is not a multiple of 36, so the last four bytes of the range are rejected rather than folded
// — folding them would make the first four letters of the alphabet commoner in every id.
const ID_MAX_BYTE = ID_RADIX * Math.floor(256 / ID_RADIX);

/**
 * Ids come from the CSPRNG so they never encode creation order and never collide across two
 * manager runs.
 */
const randomId = (prefix) => {
  const chars = [];
  while (chars.length < ID_LENGTH) {
    // Drawn a block at a time so the rejection loop does not hit the CSPRNG once per character.
    for (const byte of randomBytes(ID_LENGTH)) {
      if (byte >= ID_MAX_BYTE || chars.length === ID_LENGTH) continue;
      chars.push(ID_ALPHABET[byte % ID_RADIX]);
    }
  }
  return `${prefix}_${chars.join('')}`;
};

const now = () => new Date().toISOString();

/**
 * Quoted for an error message. Truncated because the body limit is a megabyte and every one of
 * these strings ends up in an HTTP response, a log line and very likely an agent's context.
 */
const quote = (text) =>
  text.length > MAX_QUOTED_LENGTH ? `'${text.slice(0, MAX_QUOTED_LENGTH)}…'` : `'${text}'`;

/** Error messages quote what the caller actually sent, so a type mistake is visible at a glance. */
const describe = (value) => {
  if (typeof value === 'string') return quote(value);
  if (value === null || value === undefined || typeof value !== 'object') return String(value);
  return Array.isArray(value) ? 'an array' : 'an object';
};

/**
 * Every entry point takes a caller-supplied object straight from a request body. A non-object is
 * the caller's mistake, so it must surface as a 400 here and not as a TypeError the HTTP layer
 * can only turn into a 500.
 */
const assertObject = (value, label) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object, received ${describe(value)}`);
  }
  return value;
};

/** @param {string} label 'application' or 'process' — the message names which one failed. */
const assertName = (value, label) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(
      `${label} name must be a non-empty string, received ${describe(value)}`
    );
  }
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH) {
    throw new ValidationError(
      `${label} name must be at most ${MAX_NAME_LENGTH} characters, received ${name.length}`
    );
  }
  return name;
};

/**
 * The `typeof` guard is not paranoia: the DB is plain JSON in the user's data directory, and a
 * hand-edited entry with no name must not make every later create throw a TypeError.
 */
const sameName = (stored, name) =>
  typeof stored === 'string' && stored.toLowerCase() === name.toLowerCase();

/**
 * Names are how a human addresses a process, so two that differ only in case are a trap.
 * @param {{id: string, name: string}[]} siblings the scope the name must be unique within
 * @param {string} [excludeId] the entry being renamed, which may of course keep its own name
 */
const assertUniqueName = (name, siblings, label, excludeId) => {
  const clash = siblings.find((s) => s.id !== excludeId && sameName(s.name, name));
  if (!clash) return;
  throw new ValidationError(
    `${label} name '${name}' is already in use by ${clash.id} — names are compared case-insensitively`
  );
};

const assertDescription = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ValidationError(`description must be a string, received ${describe(value)}`);
  }
  return value.trim();
};

const assertCommand = (value) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`command must be a non-empty string, received ${describe(value)}`);
  }
  const command = value.trim();
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new ValidationError(
      `command must be at most ${MAX_COMMAND_LENGTH} characters, received ${command.length}`
    );
  }
  return command;
};

const assertEnabled = (value) => {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`enabled must be true or false, received ${describe(value)}`);
  }
  return value;
};

/**
 * Both configured paths arrive as free text and are checked and resolved the same way. Exported
 * alongside `assertDirectory` for `workspace.js`, so the directory picker and the save that follows
 * it apply one definition of a usable path rather than two that can drift.
 */
export const assertAbsolutePath = (value, field) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} must be a non-empty string, received ${describe(value)}`);
  }
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new ValidationError(
      `${field} must be an absolute path (for example /path/to/project), received ${quote(trimmed)}`
    );
  }
  // resolve() also collapses '..' and drops a trailing separator, so the stored form is canonical.
  return path.resolve(trimmed);
};

/** @returns {string} the path with every symlink resolved, which is what containment compares. */
export const assertDirectory = (resolved, field) => {
  try {
    const real = realpathSync(resolved);
    if (statSync(real).isDirectory()) return real;
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'does not exist' : `cannot be read (${err.code})`;
    throw new ValidationError(`${field} ${quote(resolved)} ${reason}`);
  }
  throw new ValidationError(`${field} ${quote(resolved)} is not a directory`);
};

const assertRepositoryPath = (value) => {
  const resolved = assertAbsolutePath(value, 'repositoryPath');
  assertDirectory(resolved, 'repositoryPath');
  return resolved;
};

/** The repository root is itself a valid working directory, hence the equality case. */
const isInside = (child, parent) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** @returns {string|null} null means "use repositoryPath", which callers resolve for themselves. */
const assertWorkingDirectory = (value, repositoryPath) => {
  if (value === undefined || value === null || value === '') return null;
  const resolved = assertAbsolutePath(value, 'workingDirectory');
  // Containment is a security control, not tidiness: it is what stops a registered process from
  // being aimed at an arbitrary directory. The textual check catches '..' before any disk access,
  // and the realpath comparison catches a symlink inside the repository that points back out.
  if (!isInside(resolved, repositoryPath)) {
    throw new ValidationError(
      `workingDirectory ${quote(resolved)} must be inside repositoryPath ${quote(repositoryPath)}`
    );
  }
  const real = assertDirectory(resolved, 'workingDirectory');
  const realRoot = assertDirectory(repositoryPath, 'repositoryPath');
  if (!isInside(real, realRoot)) {
    throw new ValidationError(
      `workingDirectory ${quote(resolved)} resolves through a symlink to ${quote(real)}, which ` +
        `is outside repositoryPath ${quote(repositoryPath)}`
    );
  }
  return resolved;
};

const assertEnvValue = (key, value) => {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new ValidationError(
      `env value for '${key}' must be a string, number or boolean, received ${describe(value)}`
    );
  }
  const text = String(value);
  // An empty PATH is the one override that breaks every child ('command not found', exit 127).
  if (key === 'PATH' && text.trim() === '') {
    throw new ValidationError(
      "env value for 'PATH' must not be empty — omit the key to inherit the manager's PATH"
    );
  }
  return text;
};

const normaliseEnv = (env) => {
  if (env === undefined || env === null) return {};
  assertObject(env, 'env');
  const entries = Object.entries(env).map(([key, value]) => {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new ValidationError(
        `env name ${quote(key)} is not a valid environment variable name — expected letters, ` +
          'digits and underscores, not starting with a digit'
      );
    }
    return [key, assertEnvValue(key, value)];
  });
  // fromEntries rather than assignment: `normalised['__proto__'] = v` hits the prototype setter,
  // so a variable literally named __proto__ would be dropped without a word to the user.
  return Object.fromEntries(entries);
};

/** Every field of a new process, validated. workingDirectory is checked against the new root. */
const buildProcessFields = (input) => {
  assertObject(input, 'process input');
  const repositoryPath = assertRepositoryPath(input.repositoryPath);
  return {
    name: assertName(input.name, 'process'),
    repositoryPath,
    command: assertCommand(input.command),
    workingDirectory: assertWorkingDirectory(input.workingDirectory, repositoryPath),
    env: normaliseEnv(input.env),
    enabled: assertEnabled(input.enabled),
  };
};

/** Only the keys the caller sent are touched; everything else keeps its stored value. */
const applyProcessPatch = (current, patch) => {
  const next = { ...current };
  if (patch.name !== undefined) next.name = assertName(patch.name, 'process');
  if (patch.repositoryPath !== undefined) {
    next.repositoryPath = assertRepositoryPath(patch.repositoryPath);
  }
  if (patch.command !== undefined) next.command = assertCommand(patch.command);
  if (patch.env !== undefined) next.env = normaliseEnv(patch.env);
  if (patch.enabled !== undefined) next.enabled = assertEnabled(patch.enabled);
  // Re-checked even when untouched: a new repositoryPath must still contain the existing cwd.
  const requested =
    patch.workingDirectory !== undefined ? patch.workingDirectory : current.workingDirectory;
  next.workingDirectory = assertWorkingDirectory(requested, next.repositoryPath);
  return next;
};

const requireApplication = (doc, applicationId) => {
  const application = doc.applications.find((a) => a.id === applicationId);
  if (application) return application;
  throw new NotFoundError(`application ${describe(applicationId)} does not exist`);
};

const requireProcess = (application, processId) => {
  const proc = application.processes.find((p) => p.id === processId);
  if (proc) return proc;
  throw new NotFoundError(
    `process ${describe(processId)} does not exist in application ` +
      `'${application.name}' (${application.id})`
  );
};

const withApplication = (doc, application) => ({
  ...doc,
  applications: doc.applications.map((a) => (a.id === application.id ? application : a)),
});

const withProcesses = (application, processes) => ({
  ...application,
  processes,
  updatedAt: now(),
});

/** @returns {Promise<ApplicationConfig[]>} */
export async function listApplications() {
  const doc = await read();
  // Every config leaves this module as a copy. json-db happens to hand out copies too, but its
  // caching strategy is not part of its contract, and a view model that edited a config in place
  // must never be able to rewrite the DB by accident.
  return structuredClone(doc.applications);
}

/**
 * @param {string} applicationId
 * @returns {Promise<ApplicationConfig>}
 */
export async function getApplication(applicationId) {
  const doc = await read();
  return structuredClone(requireApplication(doc, applicationId));
}

/**
 * @param {{name: string, description?: string}} input
 * @returns {Promise<ApplicationConfig>}
 */
export async function createApplication(input = {}) {
  const { name, description } = assertObject(input, 'application input');
  const timestamp = now();
  const application = {
    id: randomId('app'),
    name: assertName(name, 'application'),
    description: assertDescription(description),
    processes: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await update((doc) => {
    assertUniqueName(application.name, doc.applications, 'application');
    return { ...doc, applications: [...doc.applications, application] };
  });
  return structuredClone(application);
}

/**
 * @param {string} applicationId
 * @param {{name?: string, description?: string}} patch
 * @returns {Promise<ApplicationConfig>}
 */
export async function updateApplication(applicationId, patch = {}) {
  assertObject(patch, 'application patch');
  let updated;
  await update((doc) => {
    const application = requireApplication(doc, applicationId);
    updated = { ...application, updatedAt: now() };
    if (patch.name !== undefined) updated.name = assertName(patch.name, 'application');
    if (patch.description !== undefined) updated.description = assertDescription(patch.description);
    assertUniqueName(updated.name, doc.applications, 'application', applicationId);
    return withApplication(doc, updated);
  });
  return structuredClone(updated);
}

/**
 * @param {string} applicationId
 * @returns {Promise<ApplicationConfig>} the removed configuration, so the caller can clean up after it
 */
export async function deleteApplication(applicationId) {
  let removed;
  await update((doc) => {
    removed = requireApplication(doc, applicationId);
    return { ...doc, applications: doc.applications.filter((a) => a.id !== applicationId) };
  });
  return structuredClone(removed);
}

/**
 * @param {string} applicationId
 * @param {{name: string, repositoryPath: string, command: string, workingDirectory?: string,
 *          env?: Record<string, unknown>, enabled?: boolean}} input
 * @returns {Promise<ProcessConfig>}
 */
export async function addProcess(applicationId, input = {}) {
  const timestamp = now();
  const proc = {
    id: randomId('proc'),
    ...buildProcessFields(input),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await update((doc) => {
    const application = requireApplication(doc, applicationId);
    assertUniqueName(proc.name, application.processes, 'process');
    return withApplication(doc, withProcesses(application, [...application.processes, proc]));
  });
  return structuredClone(proc);
}

/**
 * @param {string} applicationId
 * @param {string} processId
 * @param {object} patch any subset of the process input fields
 * @returns {Promise<ProcessConfig>}
 */
export async function updateProcess(applicationId, processId, patch = {}) {
  // Shape-checked before the mutex: a malformed body must not queue behind a pending write.
  assertObject(patch, 'process patch');
  let updated;
  await update((doc) => {
    const application = requireApplication(doc, applicationId);
    const current = requireProcess(application, processId);
    updated = { ...applyProcessPatch(current, patch), updatedAt: now() };
    assertUniqueName(updated.name, application.processes, 'process', processId);
    const processes = application.processes.map((p) => (p.id === processId ? updated : p));
    return withApplication(doc, withProcesses(application, processes));
  });
  return structuredClone(updated);
}

/**
 * @param {string} applicationId
 * @param {string} processId
 * @returns {Promise<ProcessConfig>} the removed configuration
 */
export async function removeProcess(applicationId, processId) {
  let removed;
  await update((doc) => {
    const application = requireApplication(doc, applicationId);
    removed = requireProcess(application, processId);
    const processes = application.processes.filter((p) => p.id !== processId);
    return withApplication(doc, withProcesses(application, processes));
  });
  return structuredClone(removed);
}
