import type { PmReadOutputReceipt, PmReadOutputSessionReceipt } from '@unbrained/pm-cli/sdk';

/** Evidence supplied by the serving agent; receipt metadata is not independent proof of inference or usage. */
export interface AgentContextEvidence {
  source: 'core-output-session' | 'pm-context-pack';
  receiptId: string;
  revision: string;
  servedAt: string;
  omission: { reason: string; remedy: string }[];
}

/** A consented snapshot contains receipt metadata only, never raw context or a model conversation. */
export interface AgentContextInput {
  agent: string;
  question: string;
  consent: true;
  viewers: string[];
  receipts: AgentContextEvidence[];
  gaps: { reason: string; remedy: string }[];
}

/** Immutable revision binding for one explicitly authorized audience and evidence snapshot. */
export interface AgentContextPacket extends AgentContextInput {
  id: string;
  revision: string;
  publisher: string;
  updatedAt: string;
}

/** Stable transport-neutral refusal with an actionable recovery instruction. */
export class AgentContextError extends Error {
  readonly code: 'invalid_input' | 'view_only' | 'not_found' | 'revision_conflict' | 'unavailable';
  readonly remedy: string;
  readonly status: number;
  /** Build a public-safe refusal; storage and credential details never enter the response. */
  constructor(code: AgentContextError['code'], remedy: string, status: number) {
    super(code.replaceAll('_', ' ')); this.name = 'AgentContextError'; this.code = code; this.remedy = remedy; this.status = status;
  }
}

/** Adapt actual core serving receipts without reproducing its session accounting or budget policy. */
export function coreContextEvidence(receipt: PmReadOutputSessionReceipt, output: PmReadOutputReceipt, revision: string, servedAt: string): AgentContextEvidence {
  return { source: 'core-output-session', receiptId: receipt.id, revision, servedAt,
    omission: [
      ...(receipt.suppressed_repeat_count ? [{ reason: `${receipt.suppressed_repeat_count} repeated items represented by references`, remedy: receipt.restore_reference_with }] : []),
      ...(output.rows_compacted || output.strings_compacted || output.result_omitted ? [{ reason: 'Core output budget omitted or compacted evidence', remedy: 'Repeat the source read with --output-budget unbounded.' }] : []),
    ] };
}

/** Map pm-context's public usage receipt into an explicit source reference; no runtime store is read. */
export function packContextEvidence(receipt: { protocol: 'pm-context-usage/v1'; receipt_id: string; served_at: string }, revision: string, omission: AgentContextEvidence['omission']): AgentContextEvidence {
  return { source: 'pm-context-pack', receiptId: receipt.receipt_id, servedAt: receipt.served_at, revision, omission };
}

/** Authenticated HTTP SDK; identity is verified by the server, never selected by an actor flag. */
export class AgentContextClient {
  private base: string;
  private token: string;
  /** Configure an operator-selected endpoint and session token; no hosted defaults or credential persistence. */
  constructor(baseUrl: string, token: string) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new AgentContextError('invalid_input', 'Supply an absolute pm-web HTTPS origin.', 400); }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new AgentContextError('invalid_input', 'Supply an origin without credentials, a path, query or fragment.', 400);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new AgentContextError('invalid_input', 'Use HTTPS, or HTTP on a loopback dev server.', 400);
    this.base = url.origin; this.token = token;
  }
  /** Retrieve one exact snapshot after current scope and consent checks. */
  get(project: string, id: string, revision: string): Promise<AgentContextPacket> { return this.request(project, `/${encodeURIComponent(id)}?revision=${encodeURIComponent(revision)}`, 'GET'); }
  /** Discover only packets whose explicit audience includes the authenticated principal. */
  list(project: string, offset = 0): Promise<{ packets: Pick<AgentContextPacket, 'id' | 'revision' | 'agent' | 'updatedAt'>[]; nextOffset: number | null; returned: number }> { return this.request(project, `?offset=${offset}`, 'GET'); }
  /** Publish a new snapshot, or replace an owned snapshot against its exact revision. */
  publish(project: string, input: AgentContextInput, binding?: { id: string; revision: string }): Promise<AgentContextPacket> { return this.request(project, '', 'POST', { ...input, ...(binding ? { id: binding.id, revision: binding.revision } : {}) }); }
  /** Revoke future retrieval atomically against the revision reviewed by the publisher. */
  revoke(project: string, id: string, revision: string): Promise<{ revoked: true }> { return this.request(project, `/${encodeURIComponent(id)}`, 'DELETE', { revision }); }
  /** Send a bounded authenticated request; redirects cannot forward a credential to a second endpoint. */
  private async request<T>(project: string, suffix: string, method: string, body?: unknown): Promise<T> {
    try {
      const response = await fetch(`${this.base}/api/projects/${encodeURIComponent(project)}/pm/agent-context${suffix}`, { method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json() as T & { code?: AgentContextError['code']; remedy?: string };
      if (!response.ok) throw new AgentContextError(data.code ?? 'unavailable', data.remedy ?? 'Check authentication and project access, then retry.', response.status);
      return data;
    } catch (error) {
      if (error instanceof AgentContextError) throw error;
      throw new AgentContextError('unavailable', 'Check server reachability and response format, then retry the authenticated request.', 503);
    }
  }
}
