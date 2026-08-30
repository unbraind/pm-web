// ═══════════════════════════════════════════════════════════════
// API CLIENT
// ═══════════════════════════════════════════════════════════════

/**
 * Read the host-only double-submit token from a browser cookie string.
 * Malformed percent encoding is treated as absent so an invalid cookie cannot
 * make every API call throw before it reaches the server.
 */
export function csrfTokenFromCookie(cookie = document.cookie): string | undefined {
  const encoded = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('csrf_token='))
    ?.slice('csrf_token='.length);
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/**
 * Fetch wrapper for the `/api` endpoints. Generic in `T` so each call site is
 * typed against the response interface declared in `api-types.ts`.
 */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const csrfToken = csrfTokenFromCookie();
  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
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
