import type { Router } from 'express';
import type { AuthRequest } from '../middleware/auth.ts';
import { PermissionImpactError } from '../permission-impact.ts';
import { previewPermissionImpact } from '../services/permission-impact.ts';
import { routeParam } from './route-params.ts';

/** Install an observational POST before mutation guards; the service independently requires ownership. */
export function registerPermissionImpactRoutes(router: Router): void {
  router.post('/permission-impact', async (req: AuthRequest, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    try { res.json(await previewPermissionImpact(routeParam(req, 'projectId'), req.user!.userId, req.body)); }
    catch (error) {
      const refusal = error instanceof PermissionImpactError ? error : new PermissionImpactError('unavailable', 'Check project access and backend availability, then refresh.', 503);
      res.status(refusal.status).json({ code: refusal.code, error: refusal.message, remedy: refusal.remedy });
    }
  });
}
