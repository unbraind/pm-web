import { showOfflineRecovery } from './offline-recovery.js';

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
  const session = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    ? workerSessions.get(navigator.serviceWorker) : undefined;
  const expectedAccount = session?.userId;
  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(expectedAccount && !['GET', 'HEAD'].includes(method.toUpperCase()) && !/^\/auth(?:\/|\?|$)/i.test(path)
        ? { 'X-PM-Expected-Account': expectedAccount } : {}),
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

/** Session bridge state belongs to one worker container and its current page. */
const workerSessions = new WeakMap<ServiceWorkerContainer, {
  userId: string | null; recovery: HTMLElement | null; dismissedSet: string | null;
}>();

/**
 * Tell the service worker which account is signed in, so offline-queued
 * mutations are durably bound to it.
 *
 * The worker cannot read cookies, so the page is the only component that
 * knows the session. It broadcasts the account on boot, on login and on
 * logout; the worker persists the value and stamps every queued mutation
 * with it, so a queued mutation can never be replayed under a different
 * signed-in account (see public/src/sw.ts). Pass `null` when nobody is
 * signed in. A controllerchange listener resends the latest identity after
 * first activation or a worker replacement.
 *
 * @param user - The signed-in user, or `null` after logout or a failed probe.
 */
export function syncServiceWorkerSession(user: { id: string } | null): void {
  if (!('serviceWorker' in navigator)) return;
  const workers = navigator.serviceWorker;
  let session = workerSessions.get(workers);
  if (!session) {
    session = { userId: null, recovery: null, dismissedSet: null };
    workerSessions.set(workers, session);
    const current = session;
    workers.addEventListener('controllerchange', () => {
      workers.controller?.postMessage({ type: 'AUTH_SESSION', userId: current.userId });
    });
    workers.addEventListener('message', (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: string; blocked?: unknown } | null;
      if (data?.type !== 'MUTATIONS_BLOCKED' || !Array.isArray(data.blocked)) return;
      current.recovery?.remove();
      current.recovery = null;
      // Compare the set of actionable record identities, ignoring report order.
      const blockedSet = JSON.stringify(data.blocked.map((value: unknown) => {
        const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
        return JSON.stringify(['id', 'method', 'path', 'reason', 'ownerId', 'workspace'].map((field) => {
          const entry = record[field];
          return typeof entry === 'string' || typeof entry === 'number' ? entry : null;
        }));
      }).sort());
      if (current.dismissedSet !== blockedSet) current.dismissedSet = null;
      if (data.blocked.length === 0 || current.dismissedSet === blockedSet) return;
      const recovery = showOfflineRecovery(data.blocked, current.userId, (ids, ownerId) => {
        if (current.userId !== ownerId || current.recovery !== recovery) return;
        workers.controller?.postMessage({ type: 'REBIND_RECORDS', ids, ownerId });
      }, {
        /** Carry explicit owner approval to the worker for one attention record. */
        recover: (id, ownerId, action) => {
          if (current.userId !== ownerId || current.recovery !== recovery) return;
          workers.controller?.postMessage({ type: 'RECOVER_RECORD', id, ownerId, action });
        },
        /** Suppress repeated reports for this exact set until queued work changes. */
        dismiss: () => {
          if (current.recovery !== recovery) return;
          current.dismissedSet = blockedSet;
          current.recovery = null;
        },
      });
      current.recovery = recovery;
    });
  }
  session.recovery?.remove();
  session.recovery = null;
  session.userId = user?.id ?? null;
  workers.controller?.postMessage({ type: 'AUTH_SESSION', userId: session.userId });
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
