import { requestProjectJson } from './project-http.ts';
import { ContractExplorerError, type ContractExplorerPage, type ContractReview } from './contract-explorer.ts';

/** Authenticated remote explorer SDK; tokens remain in memory and redirects never receive them. */
export class ContractExplorerClient {
  private readonly origin: string;
  private readonly token: string;
  /** Configure an explicit HTTPS endpoint (HTTP is accepted only on loopback for development). */
  constructor(baseUrl: string, token: string) {
    this.token = token;
    try {
      const url = new URL(baseUrl);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['https:', ...(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? ['http:'] : [])].includes(url.protocol)) throw new Error('Invalid origin');
      this.origin = url.origin;
    } catch { throw new ContractExplorerError('invalid_input', 'Supply a pm-web HTTPS origin without credentials, path, query or fragment.', 400); }
  }
  /** Read a bounded page or one action schema in the authenticated project scope. */
  list(project: string, options: { offset?: number; limit?: number; action?: string } = {}): Promise<ContractExplorerPage> {
    const query = new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)]));
    return this.request(project, `?${query}`, 'GET');
  }
  /** Request an unexecuted review envelope; the server refreshes availability and edit authorization. */
  review(project: string, action: string, input: Record<string, unknown>): Promise<ContractReview> {
    return this.request(project, '/review', 'POST', { action, input });
  }
  /** Transmit bounded requests and preserve only typed, public-safe server refusals. */
  private async request<T>(project: string, suffix: string, method: string, body?: unknown): Promise<T> {
    try {
      const { response, data: payload } = await requestProjectJson<T & { code?: ContractExplorerError['code']; remedy?: string }>(`${this.origin}/api/projects/${encodeURIComponent(project)}/pm/contracts${suffix}`, this.token, method, body);
      if (!response.ok) throw new ContractExplorerError(payload.code ?? 'unavailable', payload.remedy ?? 'Check authentication and project access, then retry.', response.status);
      return payload;
    } catch (error) {
      if (error instanceof ContractExplorerError) throw error;
      throw new ContractExplorerError('unavailable', 'Check server reachability and response format, then retry.', 503);
    }
  }
}
