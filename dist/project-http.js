/** Send an authenticated project request with a deadline and no credential-forwarding redirects. */
export async function requestProjectJson(endpoint, token, method, body) {
    const response = await fetch(endpoint, { method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, data: await response.json() };
}
//# sourceMappingURL=project-http.js.map