/** Validate an explicit credential-free HTTP origin for authenticated SDK clients. */
export function projectOrigin(raw: string): string {
  const url = new URL(raw);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('Invalid project origin');
  return url.origin;
}
