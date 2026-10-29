import { projectOrigin } from './project-origin.ts';
import { requestProjectJson } from './project-http.ts';
import { permissionUuid } from './permission-impact.ts';
import { EvidenceInspectionError, parseEvidenceInspection, parseEvidenceInspectionPage, type EvidenceInspectionInput, type EvidenceInspectionPage } from './evidence-inspection.ts';

/** Explicit remote inspection client stores no source snapshots or project defaults. */
export class EvidenceInspectionClient {
  private readonly origin: string;
  private readonly token: string;
  /** Bind one trusted server origin and explicit caller token without redirect forwarding. */
  constructor(baseUrl: string, token: string) {
    this.token = token;
    try { this.origin = projectOrigin(baseUrl); }
    catch { throw new EvidenceInspectionError('invalid_input', 'Supply an explicit HTTPS origin without credentials, paths, queries or fragments.'); }
  }
  /** Inspect the same authorized page the item panel consumes. */
  async inspect(project: string, raw: EvidenceInspectionInput): Promise<EvidenceInspectionPage> {
    const input = parseEvidenceInspection(raw);
    try { project = permissionUuid(project); }
    catch { throw new EvidenceInspectionError('invalid_input', 'Supply the UUID of an explicitly authorized project.'); }
    try {
      const query = new URLSearchParams({ offset: String(input.offset), limit: String(input.limit), budget: String(input.budget) });
      const { response, data } = await requestProjectJson<unknown>(`${this.origin}/api/projects/${project}/pm/evidence/${encodeURIComponent(input.item)}?${query}`, this.token, 'GET');
      if (!response.ok) {
        const row = data as { code?: unknown; remedy?: unknown } | null;
        const codes: EvidenceInspectionError['code'][] = ['invalid_input', 'not_found', 'unsupported', 'unavailable', 'conflict', 'budget'];
        throw new EvidenceInspectionError(codes.includes(row?.code as EvidenceInspectionError['code']) ? row!.code as EvidenceInspectionError['code'] : 'unavailable', typeof row?.remedy === 'string' && row.remedy.length <= 500 ? row.remedy : 'Refresh project access and backend evidence support.', response.status);
      }
      return parseEvidenceInspectionPage(data);
    } catch (error) {
      if (error instanceof EvidenceInspectionError) throw error;
      throw new EvidenceInspectionError('unavailable', 'Check server reachability, explicit project identity and authentication, then refresh.', 503);
    }
  }
}
