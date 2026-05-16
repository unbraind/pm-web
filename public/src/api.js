// ═══════════════════════════════════════════════════════════════
// API CLIENT
// ═══════════════════════════════════════════════════════════════
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api(method, path, body) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
    };
    if (body !== undefined)
        opts.body = JSON.stringify(body);
    const res = await fetch('/api' + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(String(data.error || `HTTP ${res.status}`));
    }
    return data;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getGuide(projectId) {
    return api('GET', `/projects/${projectId}/pm/guide`);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getGuideTopic(projectId, topicId) {
    return api('GET', `/projects/${projectId}/pm/guide/${encodeURIComponent(topicId)}`);
}
//# sourceMappingURL=api.js.map