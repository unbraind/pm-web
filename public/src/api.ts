// ═══════════════════════════════════════════════════════════════
// API CLIENT
// ═══════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api(method: string, path: string, body?: unknown): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  const data = await res.json().catch((): Record<string, unknown> => ({}));
  if (!res.ok) {
    throw new Error(String(data.error || `HTTP ${res.status}`));
  }
  return data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getGuide(projectId: string): Promise<any> {
  return api('GET', `/projects/${projectId}/pm/guide`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getGuideTopic(projectId: string, topicId: string): Promise<any> {
  return api('GET', `/projects/${projectId}/pm/guide/${encodeURIComponent(topicId)}`);
}
