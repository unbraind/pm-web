import { IDEMPOTENT_MUTATION_ROUTES } from './idempotency-routes.ts';
import { findCatalogEntry } from './services/package-catalog.ts';
import type { Request } from 'express';
import path from 'node:path';
import { pool } from './db.ts';
import { verifyProjectAccess } from './routes/projects.ts';
import { getAgentContext } from './services/agent-context.ts';
import { getPmClient, getProjectDir } from './services/pm-runner.ts';

/** A refusal never includes the cached body or private storage diagnostics. */
export class ReplayAccessError extends Error {
  /** Public HTTP refusal status. */
  readonly status: number;
  /** Stable agent-readable replay refusal category. */
  readonly code: string;
  /** Recovery guidance that never suggests silently repeating a committed mutation. */
  readonly remedy: string;
  /** Preserve a stable reason and remedy across every replay transport. */
  constructor(status = 403, code = 'PM_IDEMPOTENCY_REPLAY_ACCESS_REVOKED', remedy = 'Refresh current access and resource state. Reconcile the original operation before submitting new work with a new key.') {
    super('Stored response cannot be replayed with current access');
    this.status = status; this.code = code; this.remedy = remedy;
  }
}

/** The middleware supplies verified identity and the immutable recorded response, never caller-selected identity. */
export interface ReplayAccessInput { request: Request; principal: string; status: number; body: string | null }
/** Embedders must provide a current authorization policy before any body can be replayed. */
export type ReplayAuthorization = (input: ReplayAccessInput) => Promise<void>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decode only object-shaped response fields; legacy malformed success records fail closed. */
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/** Require an opaque resource identity without letting malformed cache data reach PostgreSQL casts. */
function id(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) throw new ReplayAccessError(404); return value; }
/** Require a fresh positive authorization query; SQL text is selected only by package code. */
async function requireRow(sql: string, values: unknown[], status = 404): Promise<void> { if (!(await pool.query(sql, values)).rowCount) throw new ReplayAccessError(status); }

/** Collection creates require an existing, currently owned result before their cached body can be returned. */
async function creationReplay(parts: string[], input: ReplayAccessInput, stored: Record<string, unknown>, field: string, query: string): Promise<boolean> {
  if (parts.length !== 2 || input.request.method !== 'POST') return false;
  if (input.status < 300) await requireRow(query, [id(object(stored[field]).id), input.principal]);
  return true;
}

/** Recheck group ownership, self-removal and visibility of created groups or invited members. */
async function groupReplay(parts: string[], input: ReplayAccessInput, stored: Record<string, unknown>): Promise<void> {
  const { request, principal, status } = input;
  if (await creationReplay(parts, input, stored, 'group', 'SELECT id FROM pm_groups WHERE id=$1 AND owner_id=$2')) return;
  const group = id(parts[2]);
  if (request.method === 'DELETE' && parts[3] === 'members' && parts[4] === principal) {
    await requireRow('SELECT id FROM pm_group_members WHERE group_id=$1 AND user_id=$2', [group, principal]);
  } else {
    await requireRow('SELECT id FROM pm_groups WHERE id=$1 AND owner_id=$2', [group, principal], 403);
  }
  if (parts[3] === 'members' && status < 300) {
    const member = request.method === 'POST' ? id(object(stored.member).user_id) : id(parts[4]);
    await requireRow('SELECT id FROM pm_group_members WHERE group_id=$1 AND user_id=$2', [group, member]);
  }
}

/** Recheck known item targets through the existing SDK loader, including created and Plan result resources. */
async function itemReplay(parts: string[], input: ReplayAccessInput, stored: Record<string, unknown>, project: { ownerUserId: string; slug: string }): Promise<void> {
  const ids = new Set<string>();
  const itemActions = new Set(['items', 'update', 'close', 'delete', 'comments', 'notes', 'append', 'deps', 'learnings', 'claim', 'release', 'start-task', 'pause-task', 'tests', 'restore', 'close-task', 'files', 'docs', 'plan']);
  if (parts[4] === 'create' && typeof stored.id === 'string') ids.add(stored.id);
  if (itemActions.has(parts[4] ?? '') && parts[5]) ids.add(parts[5]);
  for (const key of ['item', 'plan']) { const candidate = object(stored[key]).id; if (typeof candidate === 'string') ids.add(candidate); }
  if (parts[4] === 'decision-inbox') { const plan = object(input.request.body).planId; if (typeof plan === 'string') ids.add(plan); }
  const body = object(input.request.body);
  for (const key of ['from', 'to']) { const value = body[key]; if (typeof value === 'string') ids.add(value); }
  for (const collection of [stored.items, stored.results, body.ids]) {
    if (!Array.isArray(collection)) continue;
    for (const row of collection) {
      const value = typeof row === 'string' ? row : object(row).id ?? object(object(row).item).id;
      if (typeof value === 'string') ids.add(value);
    }
  }
  if (ids.size > 50) throw new ReplayAccessError(409, 'PM_IDEMPOTENCY_REPLAY_REQUIRES_LIVE_READ', 'Reconcile large batch results with a current bounded tracker read; the original batch will not be repeated.');
  const pm = getPmClient(path.join(getProjectDir(project.ownerUserId, project.slug), '.agents', 'pm'));
  for (const target of ids) {
    try { await pm.get(target); }
    catch { throw new ReplayAccessError(404, 'PM_IDEMPOTENCY_REPLAY_RESOURCE_CHANGED', 'The original item is no longer readable. Inspect live tracker state before submitting new work.'); }
  }
}

/** Recheck project operation capability and the visibility of cached scope-specific resources. */
async function projectReplay(parts: string[], input: ReplayAccessInput, stored: Record<string, unknown>): Promise<void> {
  const { request, principal, status } = input;
  if (await creationReplay(parts, input, stored, 'project', 'SELECT id FROM pm_projects WHERE id=$1 AND user_id=$2')) return;
  const projectId = id(parts[2]);
  const project = await verifyProjectAccess(principal, projectId);
  if (!project) throw new ReplayAccessError(404);
  const family = parts[3];
  if (parts.length === 3 || family === 'shares') {
    if (project.ownerUserId !== principal) throw new ReplayAccessError(403);
    if (family === 'shares') {
      if (status < 300) await requireRow('SELECT id FROM pm_project_shares WHERE project_id=$1 AND id=$2', [projectId, id(object(stored.share).id ?? parts[4])]);
      const group = object(request.body).groupId;
      if (typeof group === 'string') await requireRow('SELECT id FROM pm_group_members WHERE group_id=$1 AND user_id=$2', [id(group), principal]);
    }
    return;
  }
  const contextRevoke = family === 'pm' && parts[4] === 'agent-context' && request.method === 'DELETE';
  const presence = family === 'pm' && parts[4] === 'presence';
  if (!contextRevoke && !presence && project.permission !== 'edit') throw new ReplayAccessError(403);
  if (family === 'pm' && parts[4] === 'agent-context') {
    const packetId = request.method === 'POST' ? id(stored.id) : id(parts[5]);
    try {
      const packet = await getAgentContext(projectId, principal, packetId, request.method === 'POST' ? id(stored.revision) : id(object(request.body).revision));
      if (packet.publisher !== principal) throw new ReplayAccessError(403);
    } catch (error) { if (error instanceof ReplayAccessError) throw error; throw new ReplayAccessError(404, 'PM_IDEMPOTENCY_REPLAY_RESOURCE_CHANGED', 'Packet consent or revision changed. Refresh the authorized scope list; the original mutation will not be repeated.'); }
    return;
  }
  // Provider commands and presence sessions have independent, mutable capabilities.
  // Retain their keys but never replay opaque output under a project-only decision.
  if (family === 'github' || presence || (family === 'pm' && parts[4] === 'graph' && parts[5] === 'query') || (family === 'extensions' && parts[5] === 'run')) throw new ReplayAccessError(409, 'PM_IDEMPOTENCY_REPLAY_REQUIRES_LIVE_READ', 'Reconcile the original provider command or presence session through a live authorized read; its mutation will not be repeated.');
  if (family === 'extensions') { if (!findCatalogEntry(parts[4] ?? '')) throw new ReplayAccessError(404); return; }
  if (family !== 'pm') throw new ReplayAccessError();
  await itemReplay(parts, input, stored, project);
}

/** Reauthorize every production replay family; unknown routes and unreadable resources fail closed without executing handlers. */
export async function authorizeStoredReplay(input: ReplayAccessInput): Promise<void> {
  let parts: string[], stored: Record<string, unknown>;
  try {
    parts = new URL(input.request.originalUrl, 'http://localhost').pathname.split('/').filter(Boolean).map(decodeURIComponent);
    stored = object(input.body === null ? {} : JSON.parse(input.body));
  } catch { throw new ReplayAccessError(409, 'PM_IDEMPOTENCY_REPLAY_RESOURCE_CHANGED'); }
  const known = IDEMPOTENT_MUTATION_ROUTES.some(route => {
    const segments = route.path.split('/').filter(Boolean);
    return route.method === input.request.method && segments.length === parts.length && segments.every((segment, index) => segment.startsWith(':') || segment === parts[index]);
  });
  if (parts[0] !== 'api' || !known) throw new ReplayAccessError();
  if (parts[1] === 'projects') { await projectReplay(parts, input, stored); return; }
  if (parts[1] === 'groups') { await groupReplay(parts, input, stored); return; }
  if (parts[1] === 'admin') {
    await requireRow('SELECT id FROM pm_users WHERE id=$1 AND is_admin=TRUE', [input.principal], 403);
    const table = new Map([['users', 'pm_users'], ['projects', 'pm_projects'], ['groups', 'pm_groups']]).get(parts[2] ?? '');
    const target = parts[3] ?? object(stored.group).id;
    if (!table) throw new ReplayAccessError();
    if (target !== undefined) await requireRow(`SELECT id FROM ${table} WHERE id=$1`, [id(target)]);
    return;
  }
  throw new ReplayAccessError();
}
