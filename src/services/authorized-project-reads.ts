import path from 'node:path';
import { assertInitializedTracker, getContracts, getItemAt, PmClient, type ContractsResult, type GetItemAtResult, type GetResult, type PmCompleteListResult } from '@unbrained/pm-cli/sdk';
import { pool } from '../db.ts';
import { readProjectAccess, type ProjectAccess } from './project-access.ts';
import { certifyPmWebCompleteList, getProjectDir, runSerialized } from './pm-runner.ts';

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

// Cache immutable SDK bindings only, never grants, item results or authorization decisions.
const readers = new Map<string, ProjectItemReader>();
const MAX_READERS = 256;

/** Resolve storage inside the directory adapter; its identity changes with any effective authorization boundary. */
function binding(access: ProjectAccess): { directory: string; identity: string } {
  const directory = path.resolve(getProjectDir(access.ownerUserId, access.slug));
  return { directory, identity: JSON.stringify(['directory', access.id, access.ownerUserId, access.slug, access.permission, directory]) };
}

/** Construct only capabilities supported by the pinned directory SDK, with extension activation disabled. */
function directoryReader(directory: string, key: string): ProjectItemReader {
  let reader = readers.get(key);
  if (reader) readers.delete(key);
  else {
    const pmRoot = path.join(directory, '.agents', 'pm');
    const options = { pmRoot, cwd: directory, noExtensions: true };
    const client = new PmClient(options);
    reader = Object.freeze({
      get: (id: string) => client.get(id),
      complete: async (includeBody = false) => certifyPmWebCompleteList(await client.listAllComplete({ includeBody })),
      at: (id: string, ref: string) => getItemAt(id, ref, { pmRoot }),
      contracts: () => getContracts({ ...options, runtimeOnly: true }),
    });
  }
  readers.set(key, reader);
  if (readers.size > MAX_READERS) readers.delete(readers.keys().next().value!);
  return reader;
}

/**
 * Bind a live authorized project to observational SDK capabilities, then reauthorize before releasing data.
 * The workspace queue is shared with existing mutations. Recheck after waiting so a revoked or rebound
 * request never starts a storage read. The final grant lookup is the read's authorization linearization
 * point; callers must send the result without further asynchronous work. This is not a cross-store snapshot.
 */
export async function readAuthorizedProject<T>(principal: string, projectId: string, read: (reader: ProjectItemReader, access: ProjectAccess) => Promise<T>): Promise<T> {
  const access = await readProjectAccess(pool, principal, projectId);
  if (!access) throw new ProjectReadError(404);
  const selected = binding(access);
  const key = JSON.stringify([principal.toLowerCase(), selected.identity]);
  /** A cached SDK object never substitutes for current account/share authorization. */
  const authorize = async (): Promise<void> => {
    const current = await readProjectAccess(pool, principal, projectId);
    if (!current) throw new ProjectReadError(404);
    if (binding(current).identity !== selected.identity) throw new ProjectReadError(409);
  };
  return runSerialized(selected.directory, async () => {
    await authorize();
    try { await assertInitializedTracker(path.join(selected.directory, '.agents', 'pm')); }
    catch { throw new Error('Project tracker unavailable'); }
    const result = await read(directoryReader(selected.directory, key), access);
    await authorize();
    return result;
  });
}
