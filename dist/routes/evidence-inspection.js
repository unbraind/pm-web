import path from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { EvidenceInspectionError, parseEvidenceInspection } from '../evidence-inspection.js';
import { inspectEvidence } from '../services/evidence-inspection.js';
import { getProjectDir } from '../services/pm-runner.js';
import { verifyProjectAccess } from './projects.js';
import { routeParam } from './route-params.js';
/** Mount live read-only inspection before generic mutation dispatch; authorization is refreshed per call. */
export function registerEvidenceInspectionRoutes(router) {
    router.all('/evidence/:item', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store, private');
        try {
            const access = await verifyProjectAccess(req.user.userId, routeParam(req, 'projectId'));
            if (!access)
                throw new EvidenceInspectionError('not_found', 'Select a project shared with your account.', 404);
            if (req.method !== 'GET' && req.method !== 'HEAD')
                throw new EvidenceInspectionError('unsupported', 'This backend exposes read-only evidence inspection. Use pm-evidence with an authorized editor for mutations.', 405);
            if (Object.hasOwn(req.query, 'item'))
                throw new EvidenceInspectionError('invalid_input', 'Select the item through the route and use only offset, limit and budget query fields.');
            const values = { ...req.query, item: routeParam(req, 'item') };
            for (const key of ['offset', 'limit', 'budget'])
                if (typeof values[key] === 'string' && /^\d+$/.test(values[key]))
                    values[key] = Number(values[key]);
            const input = parseEvidenceInspection(values);
            const root = getProjectDir(access.ownerUserId, access.slug), workspace = path.join(root, '.agents', 'pm');
            const client = new PmClient({ cwd: root, pmRoot: workspace, noExtensions: true });
            const result = await inspectEvidence({ client, root, workspace }, input);
            // Do not release source bytes if access was revoked during source reads.
            if (!await verifyProjectAccess(req.user.userId, routeParam(req, 'projectId')))
                throw new EvidenceInspectionError('not_found', 'Project access changed. Select a project shared with your account.', 404);
            res.json(result);
        }
        catch (error) {
            const refusal = error instanceof EvidenceInspectionError ? error : new EvidenceInspectionError('unavailable', 'Check project access and tracker availability, then refresh.', 503);
            res.status(refusal.status).json({ code: refusal.code, error: refusal.message, remedy: refusal.remedy });
        }
    });
}
//# sourceMappingURL=evidence-inspection.js.map