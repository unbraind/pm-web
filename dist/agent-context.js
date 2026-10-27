import { requestProjectJson } from './project-http.js';
/** Stable transport-neutral refusal with an actionable recovery instruction. */
export class AgentContextError extends Error {
    code;
    remedy;
    status;
    /** Build a public-safe refusal; storage and credential details never enter the response. */
    constructor(code, remedy, status) {
        super(code.replaceAll('_', ' '));
        this.name = 'AgentContextError';
        this.code = code;
        this.remedy = remedy;
        this.status = status;
    }
}
/** Adapt actual core serving receipts without reproducing its session accounting or budget policy. */
export function coreContextEvidence(receipt, output, revision, servedAt) {
    return { source: 'core-output-session', receiptId: receipt.id, revision, servedAt,
        omission: [
            ...(receipt.suppressed_repeat_count ? [{ reason: `${receipt.suppressed_repeat_count} repeated items represented by references`, remedy: receipt.restore_reference_with }] : []),
            ...(output.rows_compacted || output.strings_compacted || output.result_omitted ? [{ reason: 'Core output budget omitted or compacted evidence', remedy: 'Repeat the source read with --output-budget unbounded.' }] : []),
        ] };
}
/** Map pm-context's public usage receipt into an explicit source reference; no runtime store is read. */
export function packContextEvidence(receipt, revision, omission) {
    return { source: 'pm-context-pack', receiptId: receipt.receipt_id, servedAt: receipt.served_at, revision, omission };
}
/** Authenticated HTTP SDK; identity is verified by the server, never selected by an actor flag. */
export class AgentContextClient {
    base;
    token;
    /** Configure an operator-selected endpoint and session token; no hosted defaults or credential persistence. */
    constructor(baseUrl, token) {
        let url;
        try {
            url = new URL(baseUrl);
        }
        catch {
            throw new AgentContextError('invalid_input', 'Supply an absolute pm-web HTTPS origin.', 400);
        }
        if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
            throw new AgentContextError('invalid_input', 'Supply an origin without credentials, a path, query or fragment.', 400);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
            throw new AgentContextError('invalid_input', 'Use HTTPS, or HTTP on a loopback dev server.', 400);
        this.base = url.origin;
        this.token = token;
    }
    /** Retrieve one exact snapshot after current scope and consent checks. */
    get(project, id, revision) { return this.request(project, `/${encodeURIComponent(id)}?revision=${encodeURIComponent(revision)}`, 'GET'); }
    /** Admit a baseline or resume from the last accepted cursor; no response contents are cached. */
    resume(project, id, revision, cursor, budget = 12288) {
        const query = new URLSearchParams({ revision, budget: String(budget), ...(cursor === undefined ? {} : { cursor }) });
        return this.request(project, `/${encodeURIComponent(id)}/resume?${query}`, 'GET');
    }
    /** Discover only packets whose explicit audience includes the authenticated principal. */
    list(project, offset = 0) { return this.request(project, `?offset=${offset}`, 'GET'); }
    /** Publish a new snapshot, or replace an owned snapshot against its exact revision. */
    publish(project, input, binding) { return this.request(project, '', 'POST', { ...input, ...(binding ? { id: binding.id, revision: binding.revision } : {}) }); }
    /** Revoke future retrieval atomically against the revision reviewed by the publisher. */
    revoke(project, id, revision) { return this.request(project, `/${encodeURIComponent(id)}`, 'DELETE', { revision }); }
    /** Send a bounded authenticated request; redirects cannot forward a credential to a second endpoint. */
    async request(project, suffix, method, body) {
        try {
            const { response, data } = await requestProjectJson(`${this.base}/api/projects/${encodeURIComponent(project)}/pm/agent-context${suffix}`, this.token, method, body);
            if (!response.ok)
                throw new AgentContextError(data.code ?? 'unavailable', data.remedy ?? 'Check authentication and project access, then retry.', response.status);
            return data;
        }
        catch (error) {
            if (error instanceof AgentContextError)
                throw error;
            throw new AgentContextError('unavailable', 'Check server reachability and response format, then retry the authenticated request.', 503);
        }
    }
}
//# sourceMappingURL=agent-context.js.map