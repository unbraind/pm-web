import { assertInitializedTracker, getContracts, isMutationAction } from '@unbrained/pm-cli/sdk';
/** Public-safe failures shared by SDK, HTTP and CLI. */
export class ContractExplorerError extends Error {
    code;
    remedy;
    status;
    /** Construct a stable refusal without including provider exception text. */
    constructor(code, remedy, status) {
        super(code.replaceAll('_', ' '));
        this.name = 'ContractExplorerError';
        this.code = code;
        this.remedy = remedy;
        this.status = status;
    }
}
/** Bind the existing SDK resolver to a directory tracker without invoking Git or any reviewed action. */
export function directoryContractAdapter(options) {
    return { kind: 'directory', describe: async (selection) => {
            if (!options.pmRoot)
                throw new Error('Tracker root required');
            await assertInitializedTracker(options.pmRoot);
            return getContracts({ ...options, ...selection, runtimeOnly: true });
        } };
}
/** Parse transport pagination strictly so blank, structured and boolean values cannot silently select a page. */
export function contractPageNumber(value) {
    if (value === undefined)
        return undefined;
    if ((typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) || !Number.isSafeInteger(Number(value)))
        throw new ContractExplorerError('invalid_input', 'Supply a nonnegative integer for offset or limit.', 400);
    return Number(value);
}
/** Inspect fresh provider declarations and project only public operation metadata. */
export async function exploreContracts(adapter, options = {}) {
    const offset = options.offset ?? 0, limit = options.limit ?? 20;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (options.action !== undefined && (typeof options.action !== 'string' || !options.action.trim() || options.action.length > 160))) {
        throw new ContractExplorerError('invalid_input', 'Use offset >= 0, limit 1–50 and an action from the operation list.', 400);
    }
    try {
        const snapshot = await adapter.describe({ availabilityOnly: true });
        if (!Array.isArray(snapshot.action_availability))
            throw new Error('Missing availability');
        const operations = snapshot.action_availability.map(row => {
            if (!row || typeof row.action !== 'string' || !row.action.trim() || row.action.length > 160 || typeof row.requires_extension !== 'boolean' || typeof row.available !== 'boolean' || typeof row.invocable !== 'boolean' || !['core', 'extension'].includes(row.provider) || (row.command_path !== null && typeof row.command_path !== 'string'))
                throw new Error('Invalid availability');
            const status = row.available && row.invocable ? 'available' : row.requires_extension && !row.available ? 'unsupported' : 'unavailable';
            return { action: row.action, command: row.command_path, provider: row.provider, status,
                mutation: row.provider === 'extension' || isMutationAction(row.action),
                remedy: status === 'unsupported' ? 'Enable the required provider in Packages, then refresh capabilities.' : status === 'unavailable' ? 'Check provider configuration and policy, then refresh capabilities.' : 'Review inputs against the SDK schema. Execute separately through the authorized operation surface.' };
        }).sort((a, b) => a.action.localeCompare(b.action));
        if (new Set(operations.map(row => row.action)).size !== operations.length)
            throw new Error('Ambiguous availability');
        const selected = options.action === undefined ? operations : operations.filter(row => row.action === options.action);
        if (options.action !== undefined && selected.length === 0)
            throw new ContractExplorerError('unsupported', 'Choose an action advertised by this project backend.', 424);
        const schema = options.action === undefined ? undefined : (await adapter.describe({ action: options.action, schemaOnly: true })).schema;
        return { version: 1, backend: adapter.kind, mode: 'review_only', total: selected.length, nextOffset: offset + limit < selected.length ? offset + limit : null, operations: selected.slice(offset, offset + limit), ...(schema ? { schema } : {}) };
    }
    catch (error) {
        if (error instanceof ContractExplorerError)
            throw error;
        throw new ContractExplorerError('unavailable', 'Check backend connectivity, provider configuration and project access, then refresh capabilities.', 503);
    }
}
/** Produce a bounded review envelope after a fresh availability read, without dispatching or validating the operation. */
export async function reviewContract(adapter, action, input, permission) {
    let serialized;
    try {
        serialized = JSON.stringify(input);
    }
    catch {
        throw new ContractExplorerError('invalid_input', 'Supply serializable JSON without circular references.', 400);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Buffer.byteLength(serialized, 'utf8') > 12288)
        throw new ContractExplorerError('invalid_input', 'Supply an input JSON object no larger than 12 KiB.', 400);
    const page = await exploreContracts(adapter, { action });
    const operation = page.operations[0];
    if (operation.status !== 'available')
        throw new ContractExplorerError(operation.status, operation.remedy, operation.status === 'unsupported' ? 424 : 503);
    if (operation.mutation && permission !== 'edit')
        throw new ContractExplorerError('view_only', 'Ask a project editor to review this mutation.', 403);
    return { mode: 'review_only', executed: false, validated: false, operation, input: input, remedy: 'This preview did not run the operation or validate its input semantics. Review the SDK schema and use the authorized operation surface separately.' };
}
//# sourceMappingURL=contract-explorer.js.map