import { assertInitializedTracker, getContracts, getItemAt, PmClient, PmCliError, type ContractsResult, type GetItemAtResult, type GetResult, type PmCompleteListResult } from '@unbrained/pm-cli/sdk';
import { pool } from '../db.ts';
import { readProjectAccess, type ProjectAccess } from './project-access.ts';
import { certifyPmWebCompleteList, getProjectDir, pinProjectStorage, runOnPinnedStorage, type PinnedProjectStorage } from './pm-runner.ts';

/** Narrow SDK read capabilities; neither arbitrary dispatch nor caller-supplied roots cross this boundary. */
export interface ProjectItemReader {
  get(id: string): Promise<GetResult>;
  complete(includeBody?: boolean): Promise<PmCompleteListResult>;
  at(id: string, ref: string): Promise<GetItemAtResult>;
  contracts(): Promise<ContractsResult>;
}

/** Safe access refusals contain no backend address or principal identity. */
export class ProjectReadError extends Error {
  readonly status: 404 | 409;
  /** Bind the transport status to a fixed public message. */
  constructor(status: 404 | 409) {
    super(status === 404 ? 'Project not found' : 'Project access changed; retry the read.');
    this.name = 'ProjectReadError';
    this.status = status;
  }
}

/** Only fixed SDK preflight categories survive the private provider error boundary. */
export class ProjectReadUnavailableError extends Error {
  readonly reason: string;
  /** Retain an allowlisted category without retaining provider messages, paths or recovery arguments. */
  constructor(error: unknown) {
    super('Project tracker unavailable');
    this.name = 'ProjectReadUnavailableError';
    const allowed = ['tracker_root_missing', 'tracker_root_unreadable', 'tracker_not_initialized', 'tracker_root_not_directory'];
    this.reason = error instanceof PmCliError && error.code && allowed.includes(error.code) ? error.code : 'tracker_preflight_failed';
  }
}

// Cache immutable SDK bindings only, never grants, item results or authorization decisions.
const readers = new Map<string, ProjectItemReader>();
const MAX_READERS = 256;

/**
 * Resolve storage inside the directory adapter.
 *
 * The identity includes the physical workspace and tracker, not only the logical
 * directory. Retargeting either symlink changes the identity and must refuse the read.
 *
 * @param access - Live project grant used to locate the workspace.
 * @returns The storage captured for this check and the comparable identity.
 */
function binding(access: ProjectAccess): { storage: PinnedProjectStorage; identity: string } {
  const storage = pinProjectStorage(getProjectDir(access.ownerUserId, access.slug));
  return {
    storage,
    identity: JSON.stringify(['storage', access.id, access.ownerUserId, access.slug, access.permission, storage.workspace, storage.tracker]),
  };
}

/** Construct only capabilities supported by the pinned directory SDK, with extension activation disabled. */
function directoryReader(storage: PinnedProjectStorage, key: string): ProjectItemReader {
  let reader = readers.get(key);
  if (reader) readers.delete(key);
  else {
    const options = { pmRoot: storage.tracker, cwd: storage.workspace, noExtensions: true };
    const client = new PmClient(options);
    reader = Object.freeze({
      get: (id: string) => client.get(id),
      complete: async (includeBody = false) => certifyPmWebCompleteList(await client.listAllComplete({ includeBody })),
      at: (id: string, ref: string) => getItemAt(id, ref, { pmRoot: storage.tracker, cwd: storage.workspace }),
      contracts: () => getContracts({ ...options, runtimeOnly: true }),
    });
  }
  readers.set(key, reader);
  if (readers.size > MAX_READERS) readers.delete(readers.keys().next().value!);
  return reader;
}

/**
 * Bind a live authorized project to observational SDK capabilities, then reauthorize before releasing data.
 * The workspace queue is the physical tracker captured with the binding. Recheck after waiting so a revoked,
 * rebound, or retargeted request never starts a storage read. The reader uses that same pin, so a symlink
 * change cannot move it onto the new target while it holds the old queue. The final grant and storage
 * comparison is the read's authorization linearization point; callers must send the result without further
 * asynchronous work. This is not a cross-store snapshot. The optional observer acknowledges initial
 * authorization for deterministic scheduling; it replaces no SDK or grant operation.
 */
export async function readAuthorizedProject<T>(principal: string, projectId: string, read: (reader: ProjectItemReader, access: ProjectAccess) => Promise<T>, onAuthorized: () => void = () => {}): Promise<T> {
  const access = await readProjectAccess(pool, principal, projectId);
  if (!access) throw new ProjectReadError(404);
  const selected = binding(access);
  const key = JSON.stringify([principal.toLowerCase(), selected.identity]);
  onAuthorized();
  /** A cached SDK object never substitutes for current account/share authorization or storage. */
  const authorize = async (): Promise<void> => {
    const current = await readProjectAccess(pool, principal, projectId);
    if (!current) throw new ProjectReadError(404);
    if (binding(current).identity !== selected.identity) throw new ProjectReadError(409);
  };
  return runOnPinnedStorage(selected.storage, async () => {
    await authorize();
    try { await assertInitializedTracker(selected.storage.tracker); }
    catch (error) { throw new ProjectReadUnavailableError(error); }
    const result = await read(directoryReader(selected.storage, key), access);
    await authorize();
    return result;
  });
}
