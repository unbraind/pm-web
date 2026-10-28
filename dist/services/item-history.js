/** Bounded browser history summaries over the host's explicit compact projection. */
import { createHash } from 'node:crypto';
import { EXIT_CODE } from './pm-runner.js';
/** Expected read refusals carry safe messages and a concrete recovery action. */
export class ItemHistoryError extends Error {
    /** HTTP refusal status. */
    status;
    /** Machine-readable refusal reason. */
    code;
    /** Concrete recovery advice safe for the browser. */
    remedy;
    /** Keep tracker internals out of HTTP error messages. */
    constructor(status, code, message, remedy) {
        super(message);
        this.status = status;
        this.code = code;
        this.remedy = remedy;
    }
}
/** Reject unsupported upstream shapes instead of presenting an empty timeline. */
function invalidProjection() {
    throw new ItemHistoryError(502, 'history_projection_invalid', 'The history response could not be read.', 'Check the pm host version and retry after restoring a supported history projection.');
}
/** Normalize both real compact and full output; legacy output without order is chronological. */
export function normalizeItemHistory(value) {
    if (!value || typeof value !== 'object')
        return invalidProjection();
    const data = value;
    const rows = data.compact === true ? data.compact_history : data.history;
    if (!Array.isArray(rows) || (data.order !== undefined && data.order !== 'oldest_first' && data.order !== 'newest_first'))
        return invalidProjection();
    const ordered = data.order === 'newest_first' ? [...rows].reverse() : rows;
    return ordered.map((value, offset) => {
        if (!value || typeof value !== 'object')
            return invalidProjection();
        const row = value;
        const index = row.index ?? offset + 1;
        if (!Number.isSafeInteger(index) || Number(index) < 1 || typeof row.ts !== 'string' || typeof row.op !== 'string' || typeof row.author !== 'string')
            return invalidProjection();
        return { index: Number(index), timestamp: row.ts.slice(0, 64), action: row.op.slice(0, 128), author: row.author.slice(0, 128) };
    });
}
/** Hash fixed-size summary values, never raw patches or operator paths. */
function digest(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** Require the documented page size before any host read. */
export function itemHistoryLimit(value) {
    if (value === undefined)
        return 50;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > 100) {
        throw new ItemHistoryError(400, 'invalid_history_limit', 'History limit must be an integer from 1 to 100.', 'Use limit=50 or another integer from 1 to 100.');
    }
    return Number(value);
}
/** Validate an opaque cursor against this authorized project and item before reads. */
function decodeCursor(value, scope) {
    if (value === undefined)
        return undefined;
    try {
        if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value))
            throw new Error();
        const decoded = JSON.parse(Buffer.from(value, 'base64url').toString());
        if (decoded.scope !== scope || !Number.isSafeInteger(decoded.before) || Number(decoded.before) < 2 || typeof decoded.anchor !== 'string' || !/^[a-f0-9]{64}$/.test(decoded.anchor))
            throw new Error();
        return { scope, before: Number(decoded.before), anchor: decoded.anchor };
    }
    catch {
        throw new ItemHistoryError(400, 'invalid_history_cursor', 'The history cursor is invalid for this item.', 'Restart from the latest history page without a cursor.');
    }
}
/** Translate host failures to typed safe refusals rather than silently returning no history. */
async function readRows(run, itemId, limit) {
    const result = await run(['history', itemId, '--compact', '--limit', String(limit)]);
    if (!result.ok) {
        if (result.exitCode === EXIT_CODE.NOT_FOUND)
            throw new ItemHistoryError(404, 'history_not_found', 'The item history was not found.', 'Refresh the item list and select an existing item.');
        throw new ItemHistoryError(503, 'history_unavailable', 'Item history is temporarily unavailable.', 'Retry after checking tracker availability and history integrity.');
    }
    if (!result.parsed || typeof result.parsed !== 'object' || !('compact' in result.parsed) || result.parsed.compact !== true)
        return invalidProjection();
    return normalizeItemHistory(result.parsed);
}
/** Refuse a changed physical stream rather than skipping or duplicating entries after compaction. */
function staleCursor() {
    throw new ItemHistoryError(409, 'history_cursor_stale', 'History changed since this page was loaded.', 'Restart from the latest history page without a cursor.');
}
/**
 * Read latest entries with a limit and page backwards by physical stream index.
 * Supported hosts have no backwards history cursor: older pages re-read only
 * the required latest suffix. The HTTP response always has at most limit rows
 * with bounded strings and no patches. New appends do not shift the boundary.
 */
export async function readItemHistoryPage(run, itemId, projectId, query) {
    const limit = itemHistoryLimit(query.limit);
    const scope = digest([projectId, itemId]);
    const cursor = decodeCursor(query.cursor, scope);
    let readLimit = limit;
    if (cursor) {
        const head = (await readRows(run, itemId, 1)).at(-1);
        if (!head || head.index < cursor.before)
            return staleCursor();
        readLimit = head.index - cursor.before + 1 + limit;
    }
    let rows = await readRows(run, itemId, readLimit);
    if (cursor) {
        if (digest(rows.find(row => row.index === cursor.before)) !== cursor.anchor)
            return staleCursor();
        rows = rows.filter(row => row.index < cursor.before);
    }
    const history = rows.slice(-limit);
    const first = history[0];
    const has_more = Boolean(first && first.index > 1);
    return { history, order: 'oldest_first', has_more, next_cursor: has_more ? Buffer.from(JSON.stringify({ scope, before: first.index, anchor: digest(first) })).toString('base64url') : null };
}
//# sourceMappingURL=item-history.js.map