import type { Router, Response } from 'express';
import type { AuthRequest } from '../middleware/auth.ts';
import { verifyProjectAccess } from './projects.ts';
import { routeParam } from './route-params.ts';
import { AgentContextError } from '../agent-context.ts';
import { getAgentContext, hiddenContext, listAgentContexts, publishAgentContext, revokeAgentContext } from '../services/agent-context.ts';

/** Validate opaque UUID bindings before PostgreSQL can produce a storage diagnostic. */
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new AgentContextError('invalid_input', 'Supply the packet id and exact revision from the authorized packet list.', 400);
  return value;
}

/** Recheck project access and packet consent on every request; generic pm reads never see the packet store. */
async function contextRoute(req: AuthRequest, res: Response, action: 'list' | 'get' | 'publish' | 'revoke'): Promise<void> {
  res.setHeader('Cache-Control', 'no-store, private');
  try {
    const principal = req.user!.userId;
    const project = uuid(routeParam(req, 'projectId'));
    const access = await verifyProjectAccess(principal, project);
    if (!access) hiddenContext();
    if (action === 'publish' && access.permission !== 'edit') throw new AgentContextError('view_only', 'Ask a project editor to publish a consented packet.', 403);
    const body = req.body as Record<string, unknown> | undefined;
    const result = action === 'list' ? await listAgentContexts(project, principal, req.query.offset === undefined ? 0 : typeof req.query.offset === 'string' && /^\d+$/.test(req.query.offset) ? Number(req.query.offset) : Number.NaN)
      : action === 'get' ? await getAgentContext(project, principal, uuid(routeParam(req, 'packetId')), uuid(req.query.revision))
      : action === 'revoke' ? await revokeAgentContext(project, principal, uuid(routeParam(req, 'packetId')), uuid(body?.revision))
      : await publishAgentContext(project, principal, body, body?.id === undefined && body?.revision === undefined ? undefined : { id: uuid(body?.id), revision: uuid(body?.revision) });
    res.status(action === 'publish' ? 201 : 200).json(result);
  } catch (error) {
    const refusal = error instanceof AgentContextError ? error : new AgentContextError('unavailable', 'Check project storage availability and retry.', 503);
    res.status(refusal.status).json({ error: refusal.message, code: refusal.code, remedy: refusal.remedy });
  }
}

/** Install authenticated scope routes before the general tracker command dispatcher. */
export function registerAgentContextRoutes(router: Router): void {
  router.get('/agent-context', (req: AuthRequest, res) => contextRoute(req, res, 'list'));
  router.get('/agent-context/:packetId', (req: AuthRequest, res) => contextRoute(req, res, 'get'));
  router.post('/agent-context', (req: AuthRequest, res) => contextRoute(req, res, 'publish'));
  router.delete('/agent-context/:packetId', (req: AuthRequest, res) => contextRoute(req, res, 'revoke'));
}
