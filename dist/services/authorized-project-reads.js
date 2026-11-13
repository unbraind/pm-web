import { assertInitializedTracker, getContracts, getItemAt, PmClient, PmCliError } from '@unbrained/pm-cli/sdk';
import { pool } from '../db.js';
import { readProjectAccess } from './project-access.js';
import { getProjectDir, observationalItemFolders, readObservationalCompleteList, pinProjectStorage, runOnPinnedStorage } from './pm-runner.js';
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
/** Compare canonical grant snapshots without performing filesystem work after the final SQL check. */
function grantIdentity(access) {
    return JSON.stringify([access.id, access.ownerUserId, access.slug, access.permission]);
}
/**
 * Resolve storage inside the directory adapter.
 *
 * The identity includes the physical workspace and tracker, not only the logical
 * directory. Retargeting either symlink changes the identity and must refuse the read.
 *
 * @param access - Live project grant used to locate the workspace.
 * @returns The storage captured for this check and the comparable identity.
 */
async function binding(access) {
    const storage = await pinProjectStorage(getProjectDir(access.ownerUserId, access.slug));
    return {
        storage,
        identity: JSON.stringify(['storage', grantIdentity(access), storage.workspace, storage.tracker]),
    };
}
/** Construct only capabilities supported by the pinned directory SDK, with extension activation disabled. */
function directoryReader(storage, key) {
    let reader = readers.get(key);
    if (reader)
        readers.delete(key);
    else {
        const options = { pmRoot: storage.tracker, cwd: storage.workspace, noExtensions: true };
        const client = new PmClient(options);
        reader = Object.freeze({
            get: (id) => client.get(id),
            complete: (includeBody = false) => readObservationalCompleteList(storage, includeBody),
            at: (id, ref) => getItemAt(id, ref, { pmRoot: storage.tracker, cwd: storage.workspace }),
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
 * The workspace queue is the physical tracker captured with the binding. Recheck after waiting so a revoked,
 * rebound, or retargeted request never starts a storage read. The reader uses that same pin, so a symlink
 * change cannot move it onto the new target while it holds the old queue. The final grant and storage
 * comparison is the read's authorization linearization point; callers must send the result without further
 * asynchronous work. Reader facades expire in finally when the callback settles, including failures.
 * This is not a cross-store snapshot. The optional observer acknowledges initial
 * authorization for deterministic scheduling; it replaces no SDK or grant operation.
 */
export async function readAuthorizedProject(principal, projectId, read, onAuthorized = () => { }) {
    const access = await readProjectAccess(pool, principal, projectId);
    if (!access)
        throw new ProjectReadError(404);
    const selected = await binding(access);
    const key = JSON.stringify([principal.toLowerCase(), selected.identity]);
    onAuthorized();
    /** A cached SDK object never substitutes for current account/share authorization or storage. */
    const authorize = async () => {
        const current = await readProjectAccess(pool, principal, projectId);
        if (!current)
            throw new ProjectReadError(404);
        if ((await binding(current)).identity !== selected.identity)
            throw new ProjectReadError(409);
        // Metadata resolution can wait on storage; make the final grant query after that wait.
        const admitted = await readProjectAccess(pool, principal, projectId);
        if (!admitted)
            throw new ProjectReadError(404);
        if (grantIdentity(admitted) !== grantIdentity(access))
            throw new ProjectReadError(409);
    };
    return runOnPinnedStorage(selected.storage, async () => {
        await authorize();
        try {
            await assertInitializedTracker(selected.storage.tracker);
            await observationalItemFolders(selected.storage);
        }
        catch (error) {
            throw new ProjectReadUnavailableError(error);
        }
        const cached = directoryReader(selected.storage, key);
        let active = true;
        /** Refuse escaped or detached capabilities after their owning callback settles. */
        const invoke = async (operation) => {
            if (!active)
                throw new ProjectReadError(409);
            const result = await operation();
            if (!active)
                throw new ProjectReadError(409);
            return result;
        };
        const scoped = Object.freeze({
            get: (id) => invoke(() => cached.get(id)),
            complete: (includeBody = false) => invoke(() => cached.complete(includeBody)),
            at: (id, ref) => invoke(() => cached.at(id, ref)),
            contracts: () => invoke(() => cached.contracts()),
        });
        let result;
        try {
            result = await read(scoped, access);
        }
        finally {
            active = false;
        }
        await authorize();
        return result;
    });
}
//# sourceMappingURL=authorized-project-reads.js.map