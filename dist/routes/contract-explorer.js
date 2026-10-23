import { verifyProjectAccess } from './projects.js';
import { routeParam } from './route-params.js';
import { getProjectDir } from '../services/pm-runner.js';
import { ContractExplorerError, contractPageNumber, directoryContractAdapter, exploreContracts, reviewContract } from '../contract-explorer.js';
import path from 'node:path';
/** Reauthorize every inspection and preview; never pass request data to a command dispatcher. */
async function contractRoute(req, res, review) {
    res.setHeader('Cache-Control', 'no-store, private');
    try {
        const access = await verifyProjectAccess(req.user.userId, routeParam(req, 'projectId'));
        if (!access)
            throw new ContractExplorerError('not_found', 'Select a project shared with your account.', 404);
        const directory = getProjectDir(access.ownerUserId, access.slug);
        const adapter = directoryContractAdapter({ cwd: directory, pmRoot: path.join(directory, '.agents', 'pm') });
        const result = review
            ? await reviewContract(adapter, typeof req.body?.action === 'string' ? req.body.action : '', req.body?.input, access.permission === 'edit' ? 'edit' : 'view')
            : await exploreContracts(adapter, { action: req.query.action === undefined ? undefined : typeof req.query.action === 'string' ? req.query.action : '', offset: contractPageNumber(req.query.offset), limit: contractPageNumber(req.query.limit) });
        res.json(result);
    }
    catch (error) {
        const refusal = error instanceof ContractExplorerError ? error : new ContractExplorerError('unavailable', 'Check project access and backend connectivity, then refresh capabilities.', 503);
        res.status(refusal.status).json({ code: refusal.code, error: refusal.message, remedy: refusal.remedy });
    }
}
/** Mount scoped inspection and review endpoints under the authenticated pm router. */
export function registerContractExplorerRoutes(router) {
    router.get('/contracts', (req, res) => contractRoute(req, res, false));
    router.post('/contracts/review', (req, res) => contractRoute(req, res, true));
}
//# sourceMappingURL=contract-explorer.js.map