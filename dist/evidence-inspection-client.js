import { projectOrigin } from './project-origin.js';
import { requestProjectJson } from './project-http.js';
import { permissionUuid } from './permission-impact.js';
import { EvidenceInspectionError, parseEvidenceInspection, parseEvidenceInspectionPage } from './evidence-inspection.js';
/** Explicit remote inspection client stores no source snapshots or project defaults. */
export class EvidenceInspectionClient {
    origin;
    token;
    /** Bind one trusted server origin and explicit caller token without redirect forwarding. */
    constructor(baseUrl, token) {
        this.token = token;
        try {
            this.origin = projectOrigin(baseUrl);
        }
        catch {
            throw new EvidenceInspectionError('invalid_input', 'Supply an explicit HTTPS origin without credentials, paths, queries or fragments.');
        }
    }
    /** Inspect the same authorized page the item panel consumes. */
    async inspect(project, raw) {
        const input = parseEvidenceInspection(raw);
        try {
            project = permissionUuid(project);
            const query = new URLSearchParams({ offset: String(input.offset), limit: String(input.limit), budget: String(input.budget) });
            const { response, data } = await requestProjectJson(`${this.origin}/api/projects/${project}/pm/evidence/${encodeURIComponent(input.item)}?${query}`, this.token, 'GET');
            if (!response.ok) {
                const row = data;
                const codes = ['invalid_input', 'not_found', 'unsupported', 'unavailable', 'conflict', 'budget'];
                throw new EvidenceInspectionError(codes.includes(row?.code) ? row.code : 'unavailable', typeof row?.remedy === 'string' && row.remedy.length <= 500 ? row.remedy : 'Refresh project access and backend evidence support.', response.status);
            }
            return parseEvidenceInspectionPage(data);
        }
        catch (error) {
            if (error instanceof EvidenceInspectionError)
                throw error;
            throw new EvidenceInspectionError('unavailable', 'Check server reachability, explicit project identity and authentication, then refresh.', 503);
        }
    }
}
//# sourceMappingURL=evidence-inspection-client.js.map