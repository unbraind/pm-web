import type { Router, Response } from 'express';
import type { AuthRequest } from '../middleware/auth.ts';
import { verifyProjectAccess } from './projects.ts';
import { routeParam } from './route-params.ts';
import { getProjectDir } from '../services/pm-runner.ts';
import { ContractExplorerError, contractPageNumber, directoryContractAdapter, exploreContracts, reviewContract } from '../contract-explorer.ts';
import path from 'node:path';

/** Reauthorize every inspection and preview; never pass request data to a command dispatcher. */
async function contractRoute(req: AuthRequest, res: Response, review: boolean): Promise<void> {
  res.setHeader('Cache-Control', 'no-store, private');
  try {
    const access = await verifyProjectAccess(req.user!.userId, routeParam(req, 'projectId'));
    if (!access) throw new ContractExplorerError('not_found', 'Select a project shared with your account.', 404);
    const directory = getProjectDir(access.ownerUserId, access.slug);
    const adapter = directoryContractAdapter({ cwd: directory, pmRoot: path.join(directory, '.agents', 'pm') });
    const result = review
      ? await reviewContract(adapter, typeof req.body?.action === 'string' ? req.body.action : '', req.body?.input, access.permission === 'edit' ? 'edit' : 'view')
      : await exploreContracts(adapter, { action: req.query.action === undefined ? undefined : typeof req.query.action === 'string' ? req.query.action : '', offset: contractPageNumber(req.query.offset), limit: contractPageNumber(req.query.limit) });
    res.json(result);
  } catch (error) {
    const refusal = error instanceof ContractExplorerError ? error : new ContractExplorerError('unavailable', 'Check project access and backend connectivity, then refresh capabilities.', 503);
    res.status(refusal.status).json({ code: refusal.code, error: refusal.message, remedy: refusal.remedy });
  }
}
/** Mount scoped inspection and review endpoints under the authenticated pm router. */
export function registerContractExplorerRoutes(router: Router): void {
  router.get('/contracts', (req: AuthRequest, res) => contractRoute(req, res, false));
  router.post('/contracts/review', (req: AuthRequest, res) => contractRoute(req, res, true));
}
