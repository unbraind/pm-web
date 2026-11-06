import path from 'node:path';
import { assertInitializedTracker, getContracts, getItemAt, PmClient, PmCliError } from '@unbrained/pm-cli/sdk';
import { pool } from '../db.js';
import { readProjectAccess } from './project-access.js';
import { certifyPmWebCompleteList, getProjectDir, runSerialized } from './pm-runner.js';
/** Safe access refusals contain no backend address or principal identity. */
export class ProjectReadError extends Error {
    status;
    /** Bind the transport status to a fixed public message. */
    constructor(status) {
        super(status === 404 ? 'Project not found' : 'Project access changed; retry the read.');
        this.name = 'ProjectReadError';
        this.status = status;
    }
}
/** Only fixed SDK preflight categories survive the private provider error boundary. */
export class ProjectReadUnavailableError extends Error {
    reason;
    /** Retain an allowlisted category without retaining provider messages, paths or recovery arguments. */
    constructor(error) {
        super('Project tracker unavailable');
        this.name = 'ProjectReadUnavailableError';
        const allowed = ['tracker_root_missing', 'tracker_root_unreadable', 'tracker_not_initialized', 'tracker_root_not_directory'];
        this.reason = error instanceof PmCliError && error.code && allowed.includes(error.code) ? error.code : 'tracker_preflight_failed';
    }
}
// Cache immutable SDK bindings only, never grants, item results or authorization decisions.
const readers = new Map();
const MAX_READERS = 256;
/** Resolve storage inside the directory adapter; its identity changes with any effective authorization boundary. */
function binding(access) {
    const directory = path.resolve(getProjectDir(access.ownerUserId, access.slug));
    return { directory, identity: JSON.stringify(['directory', access.id, access.ownerUserId, access.slug, access.permission, directory]) };
}
/** Construct only capabilities supported by the pinned directory SDK, with extension activation disabled. */
function directoryReader(directory, key) {
    let reader = readers.get(key);
    if (reader)
        readers.delete(key);
    else {
        const pmRoot = path.join(directory, '.agents', 'pm');
        const options = { pmRoot, cwd: directory, noExtensions: true };
        const client = new PmClient(options);
        reader = Object.freeze({
            get: (id) => client.get(id),
            complete: async (includeBody = false) => certifyPmWebCompleteList(await client.listAllComplete({ includeBody })),
            at: (id, ref) => getItemAt(id, ref, { pmRoot }),
            contracts: () => getContracts({ ...options, runtimeOnly: true }),
        });
    }
    readers.set(key, reader);
    if (readers.size > MAX_READERS)
        readers.delete(readers.keys().next().value);
    return reader;
}
/**
 * Bind a live authorized project to observational SDK capabilities, then reauthorize before releasing data.
 * The workspace queue is shared with existing mutations. Recheck after waiting so a revoked or rebound
 * request never starts a storage read. The final grant lookup is the read's authorization linearization
 * point; callers must send the result without further asynchronous work. This is not a cross-store snapshot.
 * The optional observer acknowledges initial authorization for deterministic scheduling; it replaces no SDK or grant operation.
 */
export async function readAuthorizedProject(principal, projectId, read, onAuthorized = () => { }) {
    const access = await readProjectAccess(pool, principal, projectId);
    if (!access)
        throw new ProjectReadError(404);
    const selected = binding(access);
    const key = JSON.stringify([principal.toLowerCase(), selected.identity]);
    onAuthorized();
    /** A cached SDK object never substitutes for current account/share authorization. */
    const authorize = async () => {
        const current = await readProjectAccess(pool, principal, projectId);
        if (!current)
            throw new ProjectReadError(404);
        if (binding(current).identity !== selected.identity)
            throw new ProjectReadError(409);
    };
    return runSerialized(selected.directory, async () => {
        await authorize();
        try {
            await assertInitializedTracker(path.join(selected.directory, '.agents', 'pm'));
        }
        catch (error) {
            throw new ProjectReadUnavailableError(error);
        }
        const result = await read(directoryReader(selected.directory, key), access);
        await authorize();
        return result;
    });
}
//# sourceMappingURL=authorized-project-reads.js.map