import { projectOrigin } from './project-origin.js';
import { requestProjectJson } from './project-http.js';
import { PermissionImpactError, permissionUuid, parsePermissionImpact, parsePermissionImpactPage } from './permission-impact.js';
/** Authenticated consequence previews never send credentials to redirects or persist results. */
export class PermissionImpactClient {
    origin;
    token;
    /** Select an explicit HTTPS origin, with loopback HTTP permitted for development. */
    constructor(baseUrl, token) {
        this.token = token;
        try {
            this.origin = projectOrigin(baseUrl);
        }
        catch {
            throw new PermissionImpactError('invalid_input', 'Supply an explicit HTTPS origin without credentials, path, query or fragment.', 400);
        }
    }
    /** Inspect one existing share proposal after fresh server authorization; no apply method exists. */
    async preview(project, raw) {
        const input = parsePermissionImpact(raw);
        project = permissionUuid(project);
        try {
            const { response, data } = await requestProjectJson(`${this.origin}/api/projects/${encodeURIComponent(project)}/pm/permission-impact`, this.token, 'POST', input);
            if (!response.ok) {
                const row = data;
                const code = row && ['invalid_input', 'view_only', 'owner_required', 'not_found', 'unavailable'].includes(String(row.code)) ? row.code : 'unavailable';
                throw new PermissionImpactError(code, typeof row?.remedy === 'string' && row.remedy.length <= 500 ? row.remedy : 'Check authentication and project ownership, then refresh.', response.status);
            }
            try {
                return parsePermissionImpactPage(data);
            }
            catch {
                throw new PermissionImpactError('unavailable', 'Refresh after the server returns a valid permission impact response.', 503);
            }
        }
        catch (error) {
            if (error instanceof PermissionImpactError)
                throw error;
            throw new PermissionImpactError('unavailable', 'Check server reachability and response schema, then refresh the preview.', 503);
        }
    }
}
//# sourceMappingURL=permission-impact-client.js.map