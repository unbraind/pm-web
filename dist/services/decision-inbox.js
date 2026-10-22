import { createHash, randomUUID } from 'node:crypto';
import { acquireLock, listAllComplete, isPmCliExpectedError, EXIT_CODE } from '@unbrained/pm-cli/sdk';
import { getPmClient } from './pm-runner.js';
/** Stable refusals with a concrete next action for human and agent clients. */
export class DecisionInboxError extends Error {
    /** Build a transport-neutral refusal without exposing storage details. */
    code;
    remedy;
    status;
    constructor(code, remedy, status) {
        super(code.replaceAll('_', ' '));
        this.name = 'DecisionInboxError';
        this.code = code;
        this.remedy = remedy;
        this.status = status;
    }
}
const PREFIX = 'pm-web:decision-inbox:v1:';
/** Require bounded nonempty strings before storing or interpreting an inbox record. */
function text(value, max) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
/** Refuse malformed transport input with the same typed contract on every surface. */
function invalid() {
    throw new DecisionInboxError('invalid_input', 'Supply a plan id, bounded text, 2–8 distinct alternatives and evidence; responses need the current revision, action, reason and a zero-based choice for approval.', 400);
}
/** Preserve absent pagination defaults while refusing blank or structured transport values. */
export function decisionInboxNumber(raw, fallback) {
    if (raw === undefined)
        return fallback;
    if (typeof raw === 'number')
        return raw;
    return typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
}
/** Decode only explicit versioned entries; unrelated core decisions remain outside this workflow. */
function decode(rationale) {
    if (!rationale?.startsWith(PREFIX))
        return;
    let row;
    try {
        row = JSON.parse(rationale.slice(PREFIX.length));
    }
    catch {
        invalid();
    }
    if (!row || typeof row !== 'object')
        invalid();
    const data = row;
    if (!text(data.id, 80))
        invalid();
    if (data.kind === 'request') {
        if (!text(data.question, 1000) || !Array.isArray(data.alternatives) || data.alternatives.length < 2 || data.alternatives.length > 8 || !data.alternatives.every(value => text(value, 240)) || new Set(data.alternatives).size !== data.alternatives.length)
            invalid();
        return { kind: 'request', id: data.id, question: data.question, alternatives: data.alternatives };
    }
    if ((data.kind !== 'approve' && data.kind !== 'acknowledge') || !text(data.revision, 64) || !text(data.reason, 2000) || (data.kind === 'approve' && (!Number.isInteger(data.alternative) || Number(data.alternative) < 0 || Number(data.alternative) > 7)))
        invalid();
    return { kind: data.kind, id: data.id, revision: data.revision, reason: data.reason, ...(data.kind === 'approve' ? { alternative: Number(data.alternative) } : {}) };
}
/** Project the existing core log without inventing an item type or changing plan lifecycle. */
function project(plan) {
    try {
        return projectRecords(plan);
    }
    catch (error) {
        if (!(error instanceof DecisionInboxError) || error.code !== 'invalid_input')
            throw error;
        throw new DecisionInboxError('invalid_record', `Inspect Plan ${plan.id} with pm plan show and repair malformed or duplicate decision-inbox records before retrying.`, 503);
    }
}
/** Validate the stored envelopes as one log so ambiguous requests cannot receive responses. */
function projectRecords(plan) {
    const decisions = plan.decisions ?? [];
    const records = decisions.map(entry => ({ entry, record: decode(entry.rationale) }));
    const responsesById = new Map();
    for (const row of records) {
        if (!row.record || row.record.kind === 'request')
            continue;
        const group = responsesById.get(row.record.id) ?? [];
        group.push(row);
        responsesById.set(row.record.id, group);
    }
    const requestIds = new Set();
    return records.flatMap(({ entry, record }) => {
        if (record?.kind !== 'request')
            return [];
        if (!text(entry.evidence, 2000) || !text(entry.author, 160))
            invalid();
        if (requestIds.has(record.id))
            invalid();
        requestIds.add(record.id);
        const responses = responsesById.get(record.id) ?? [];
        return [{ planId: plan.id, id: record.id, question: record.question, alternatives: record.alternatives, evidence: entry.evidence ?? '', author: entry.author, createdAt: entry.ts,
                revision: createHash('sha256').update(JSON.stringify([entry, ...responses.map(row => row.entry)])).digest('hex'),
                status: responses.some(row => row.record?.kind === 'approve') ? 'answered' : 'pending',
                acknowledgments: responses.filter(row => row.record?.kind === 'acknowledge').length }];
    });
}
/** Require edit capability before any lock, tracker read, or SDK mutation. */
function editor(actor) {
    if (actor.permission !== 'edit')
        throw new DecisionInboxError('view_only', 'Ask a project editor to respond or request edit access.', 403);
    if (!text(actor.author, 160))
        invalid();
}
/** Read one plan through the existing cached SDK loader. */
async function readPlan(pmRoot, id) {
    if (!text(id, 160))
        invalid();
    try {
        return await getPmClient(pmRoot).planShow(id, { depth: 'deep' });
    }
    catch (error) {
        if (isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND)
            throw new DecisionInboxError('not_found', 'Refresh the inbox and select an existing Plan.', 404);
        if (isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.USAGE)
            throw new DecisionInboxError('invalid_input', 'Select an existing Plan; other item types cannot hold plan decision requests.', 400);
        throw new DecisionInboxError('unavailable', 'Inspect the Plan with pm plan show and verify tracker availability before retrying.', 503);
    }
}
/** List pending requests using a certified complete source read and bounded output pagination. */
export async function listDecisionInbox(pmRoot, options = {}) {
    const limit = options.limit ?? 20, offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0)
        invalid();
    const corpus = await listAllComplete({}, { pmRoot, noExtensions: true }).catch(() => {
        throw new DecisionInboxError('unavailable', 'Inspect tracker health and availability before refreshing the inbox.', 503);
    });
    const requests = corpus.items.filter(item => item.type === 'Plan').flatMap(item => project({ id: item.id, decisions: item.plan_decisions ?? [] }))
        .filter(request => request.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const page = [];
    let bytes = 256;
    for (const request of requests.slice(offset, offset + limit)) {
        const size = Buffer.byteLength(JSON.stringify(request), 'utf8') + 1;
        if (size > 16000)
            invalid();
        if (bytes + size > 16384)
            break;
        page.push(request);
        bytes += size;
    }
    const end = offset + page.length;
    return { requests: page, total: requests.length, nextOffset: end < requests.length ? end : null, codeReview: false, taskCompletion: false };
}
/** Append a request through the audited core plan decision mutation; no schema or lifecycle change. */
export async function requestDecision(pmRoot, actor, input) {
    editor(actor);
    if (!input || !text(input.question, 1000) || !text(input.evidence, 2000) || !Array.isArray(input.alternatives))
        invalid();
    const record = { kind: 'request', id: randomUUID(), question: input.question.trim(), alternatives: input.alternatives.map(value => typeof value === 'string' ? value.trim() : value) };
    decode(PREFIX + JSON.stringify(record));
    if (Buffer.byteLength(JSON.stringify([record, input.evidence, actor.author, input.planId]), 'utf8') > 14000)
        invalid();
    await readPlan(pmRoot, input.planId);
    await getPmClient(pmRoot).planDecision(input.planId, { decisionText: record.question, decisionRationale: PREFIX + JSON.stringify(record), decisionEvidence: input.evidence.trim(), author: actor.author, message: 'Request a human-agent decision' });
    return project((await readPlan(pmRoot, input.planId)).plan).find(request => request.id === record.id);
}
/** Serialize cross-process responses with a public SDK lock and check revisions inside it before audited append. */
export async function respondToDecision(pmRoot, actor, input) {
    editor(actor);
    if (!input || !text(input.planId, 160) || !text(input.requestId, 80) || !text(input.revision, 64) || !text(input.reason, 2000) || !['approve', 'acknowledge'].includes(input.action))
        invalid();
    const planId = (await readPlan(pmRoot, input.planId)).plan.id;
    const key = createHash('sha256').update(JSON.stringify([planId, input.requestId])).digest('hex');
    const release = await acquireLock(pmRoot, `web-inbox-${key}`, 120, actor.author, false, true, 5000);
    try {
        const request = project((await readPlan(pmRoot, planId)).plan).find(row => row.id === input.requestId);
        if (!request)
            throw new DecisionInboxError('not_found', 'Refresh the inbox and select an existing request.', 404);
        if (request.revision !== input.revision)
            throw new DecisionInboxError('revision_conflict', 'Refresh the inbox, inspect the latest evidence and submit against its new revision.', 409);
        if (request.status === 'answered')
            throw new DecisionInboxError('already_answered', 'Create a new request if the decision needs reconsideration.', 409);
        if (input.action === 'approve' && (!Number.isInteger(input.alternative) || Number(input.alternative) < 0 || Number(input.alternative) >= request.alternatives.length))
            invalid();
        const record = { kind: input.action, id: input.requestId, revision: input.revision, reason: input.reason.trim(), ...(input.action === 'approve' ? { alternative: input.alternative } : {}) };
        await getPmClient(pmRoot).planDecision(planId, { decisionText: input.action === 'approve' ? `Approved: ${request.alternatives[input.alternative]}` : `Acknowledged: ${request.question}`, decisionRationale: PREFIX + JSON.stringify(record), author: actor.author, message: 'Respond to a human-agent decision; no review or completion' });
        return { request: project((await readPlan(pmRoot, planId)).plan).find(row => row.id === input.requestId), codeReview: false, taskCompletion: false };
    }
    finally {
        await release().catch(() => undefined);
    }
}
//# sourceMappingURL=decision-inbox.js.map