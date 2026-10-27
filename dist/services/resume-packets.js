import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { listMutationEvents, readHistoryEntries, getHistoryPath } from '@unbrained/pm-cli/sdk';
import { AgentContextError } from '../agent-context.js';
const fallbackKey = randomBytes(32);
/** Use the deployment's shared session secret so cursors survive replicas and restarts; rotation requires reorientation. */
function key() { return process.env.JWT_SECRET ? createHash('sha256').update(`pm-web-resume/v1:${process.env.JWT_SECRET}`).digest() : fallbackKey; }
/** Hash exact SDK values without implementing native-field normalization. */
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** Reorientation is mandatory whenever a cursor cannot prove the previously admitted prefix. */
function reorient() { throw new AgentContextError('reorientation_required', 'Reorient with the current authorized question and selected items, then admit a fresh baseline without a cursor.', 409); }
/** Encrypt only frontier metadata, never a pending change or context snapshot. */
function seal(state) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), nonce);
    cipher.setAAD(Buffer.from('pm-web-resume/v1'));
    const body = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
}
/** Authenticate opaque metadata before using any count, hash or identity supplied by a caller. */
function open(token) {
    try {
        if (!/^[A-Za-z0-9_-]{40,8192}$/.test(token))
            return reorient();
        const bytes = Buffer.from(token, 'base64url'), decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from('pm-web-resume/v1'));
        decipher.setAuthTag(bytes.subarray(12, 28));
        const state = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
        if (state.protocol !== 1 || !Array.isArray(state.streams) || state.streams.length > 20 || !state.streams.every(row => Number.isSafeInteger(row.count) && row.count >= 0 && typeof row.hash === 'string'))
            return reorient();
        return state;
    }
    catch {
        return reorient();
    }
}
/** Read every selected stream through SDK query cursors; bound work and refuse rather than certify an incomplete scan. */
async function streams(pmRoot, items, step, authorize) {
    const result = new Map(items.map(item => [item, []]));
    let since;
    let count = 0;
    do {
        await step('before-sdk-page');
        await authorize();
        const page = await listMutationEvents({ pmRoot, item: items, full: true, cursorMode: 'batch', limit: 1000, since });
        await step('after-sdk-page');
        count += page.count;
        if (count > 10000)
            throw new AgentContextError('unavailable', 'Selected history exceeds the 10000-event scan bound. Narrow the publisher-selected items or ask an operator to review retention before reorienting.', 503);
        for (const event of page.events)
            result.get(event.item_id)?.push(event);
        if (!page.has_more)
            break;
        if (!page.next_cursor || page.next_cursor === since)
            return reorient();
        since = page.next_cursor;
    } while (true);
    for (const item of result.keys()) {
        await step('before-authoritative-read');
        await authorize();
        const authoritative = await readHistoryEntries(getHistoryPath(pmRoot, item), item);
        await step('after-authoritative-read');
        // The SDK index is disposable. Verify exact authoritative entries before certifying its prefix.
        // A racing append is included by physical version even if its timestamp is behind the SDK cursor.
        result.set(item, authoritative.map((entry, i) => ({ item_id: item, version: i + 1, ts: entry.ts, author: entry.author, type: entry.op, patch_count: entry.patch.length, entry })));
        if ([...result.values()].reduce((sum, entries) => sum + entries.length, 0) > 10000)
            throw new AgentContextError('unavailable', 'Narrow the publisher-selected items to keep retained history within 10000 events, then retry.', 503);
    }
    return result;
}
/** Bind a prefix to physical versions and every native history field, including relationships and exact whitespace. */
function prefix(item, rows, count) {
    return { item, count, hash: digest(rows.slice(0, count).map(row => [row.version, row.entry])) };
}
/** Emit bounded field references rather than raw patches, messages or private source contents. */
function change(row) {
    const fields = [...new Set((row.entry?.patch ?? []).map(patch => patch.path))].sort();
    return { key: digest([row.item_id, row.version, row.entry]), item: row.item_id, version: row.version, operation: row.type, fields: fields.slice(0, 20).map(field => field.slice(0, 160)), omittedFields: Math.max(0, fields.length - 20) + fields.slice(0, 20).filter(field => field.length > 160).length };
}
/** Stabilize the byte receipt including the receipt's own digits. */
function measure(packet) {
    for (let i = 0; i < 4; i++)
        packet.budget.bytes = Buffer.byteLength(JSON.stringify(packet));
    return packet.budget.bytes;
}
/**
 * Admit or resume an authorized question. Callers recheck live authorization at both boundaries.
 * The optional observer is a deterministic scheduling seam; it never replaces SDK storage or authorization.
 * Only returned rows advance the encrypted frontier. Replaying an old cursor returns stable event keys,
 * while advancing the accepted cursor delivers each immutable event once, including backdated appends.
 */
export async function buildResumePacket(pmRoot, binding, options, authorize, step = async () => { }) {
    await step('before-authorization');
    const scope = await authorize();
    await step('after-authorization');
    if (scope.id !== binding.id || scope.revision !== binding.revision)
        return reorient();
    const items = scope.items;
    if (!items?.length)
        throw new AgentContextError('reorientation_required', 'Ask the publisher to select question-relevant items in the consented context packet, then reorient and admit a baseline.', 409);
    const budget = options.budget ?? 12288;
    if (!Number.isSafeInteger(budget) || budget < 2048 || budget > 16384)
        throw new AgentContextError('invalid_input', 'Supply a UTF-8 JSON budget from 2048 to 16384 bytes.', 400);
    const identity = digest([binding, items, scope.question]);
    const previous = options.cursor === undefined ? undefined : open(options.cursor);
    if (previous && (previous.binding !== identity || previous.streams.length !== items.length || previous.streams.some((row, i) => row.item !== items[i])))
        return reorient();
    const source = await streams(pmRoot, items, step, authorize);
    const frontier = items.map((item, i) => {
        const rows = source.get(item);
        if (!rows.length && !previous)
            return reorient();
        const old = previous?.streams[i];
        if (old && (old.count > rows.length || prefix(item, rows, old.count).hash !== old.hash))
            return reorient();
        return prefix(item, rows, old?.count ?? rows.length);
    });
    const pending = previous ? items.flatMap((item, i) => source.get(item).slice(frontier[i].count)) : [];
    const packet = { protocol: 'pm-web-resume/v1', phase: previous ? 'delta' : 'admitted', revision: binding.revision, cursor: '', changes: [], receipt: { complete: true, missed: pending.length, returned: 0, deferred: pending.length, baselineEvents: frontier.reduce((sum, row) => sum + row.count, 0), source: 'sdk-history', remedy: '' }, budget: { bytes: 0, ceiling: budget } };
    /** Refresh opaque metadata and completeness after each whole-row admission. */
    const update = () => {
        packet.cursor = seal({ protocol: 1, binding: identity, streams: frontier });
        packet.receipt.returned = packet.changes.length;
        packet.receipt.deferred = pending.length - packet.changes.length;
        packet.receipt.complete = packet.receipt.deferred === 0;
        packet.receipt.remedy = packet.receipt.complete ? 'Persist the accepted cursor; fetch native items through the authorized project SDK for full state.' : 'Resume with this cursor for deferred changes; no deferred row has been admitted.';
        measure(packet);
    };
    update();
    for (const row of pending.slice(0, 50)) {
        const index = items.indexOf(row.item_id), before = frontier[index];
        frontier[index] = prefix(row.item_id, source.get(row.item_id), row.version);
        packet.changes.push(change(row));
        update();
        if (packet.budget.bytes > budget) {
            packet.changes.pop();
            frontier[index] = before;
            update();
            break;
        }
    }
    if (packet.budget.bytes > budget || (pending.length > 0 && packet.changes.length === 0))
        throw new AgentContextError('budget_too_small', 'Increase the packet budget to fit the cursor, receipts and at least one whole change; no cursor advanced.', 409);
    await step('before-final-authorization');
    const current = await authorize();
    if (current.revision !== scope.revision || current.id !== scope.id)
        return reorient();
    // Authorization above is the read's linearization point; no asynchronous work follows it.
    return packet;
}
//# sourceMappingURL=resume-packets.js.map