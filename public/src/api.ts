// ═══════════════════════════════════════════════════════════════
// API CLIENT
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch wrapper for the `/api` endpoints. Generic in `T` so each call site is
 * typed against the response interface declared in `api-types.ts`.
 */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  const data = await res.json().catch((): Record<string, unknown> => ({})) as T;
  if (!res.ok) {
    throw new Error(String((data as Record<string, unknown>).error || `HTTP ${res.status}`));
  }
  return data;
}

/** Response from `GET /api/projects/:projectId/pm/guide` — see src/routes/pm.ts. */
export async function getGuide(projectId: string): Promise<GuideResponse> {
  return api<GuideResponse>('GET', `/projects/${projectId}/pm/guide`);
}

/** Response from `GET /api/projects/:projectId/pm/guide/:topicId` — see src/routes/pm.ts. */
export async function getGuideTopic(projectId: string, topicId: string): Promise<GuideTopicResponse> {
  return api<GuideTopicResponse>('GET', `/projects/${projectId}/pm/guide/${encodeURIComponent(topicId)}`);
}

/** Guide topic list envelope from `pm guide`. */
export interface GuideResponse {
  topics?: Array<{ id?: string; title?: string; description?: string }>;
  error?: string;
  [key: string]: unknown;
}

/** A single guide topic from `pm guide <topic>`. */
export interface GuideTopicResponse {
  id?: string;
  title?: string;
  body?: string;
  content?: string;
  error?: string;
  [key: string]: unknown;
}