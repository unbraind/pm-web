/** Synthetic browser-review data. This server never opens a database or tracker. */
import type { Item } from '../public/src/types.ts';

/** Synthetic signed-in editor used only by browser review. */
export const fixtureUser = { id: 'fixture-owner', email: 'editor@example.test', display_name: 'Morgan', is_admin: true, created_at: '2026-10-01T10:00:00Z' };
/** Synthetic project shown in the screenshot matrix. */
export const fixtureProject = { id: 'fixture-project', slug: 'field-notes', name: 'Field notes', prefix: 'note', description: 'A shared workspace for the next release.', created_at: '2026-10-01T10:00:00Z' };
/** One synthetic record per lifecycle state for repeatable screen coverage. */
export const fixtureItems: Item[] = ['open', 'in_progress', 'blocked', 'closed', 'canceled'].map((status, index) => ({
  id: `note-${index + 1}`, type: ['Feature', 'Task', 'Bug', 'Task', 'Chore'][index], status, priority: index,
  title: ['Make the next step clear', 'Review the field notes', 'Resolve the export permission', 'Link the release evidence', 'Retire the old checklist'][index],
  description: 'Keep the work, decisions and evidence together. Every collaborator works from the same record.',
  assignee: 'Morgan', tags: ['release'], deadline: '2026-10-22', created_at: '2026-10-16T10:00:00Z', updated_at: '2026-10-17T09:00:00Z',
  ...(status === 'blocked' ? { blockedReason: 'Waiting for the permission review. Ask the project owner to confirm access.' } : {}),
}));

/** Return only synthetic responses for the UI evidence harness. */
export function fixtureResponse(pathname: string): unknown {
  if (pathname === '/api/auth/me') return { user: fixtureUser };
  if (pathname.endsWith('/oidc/config')) return { enabled: false, label: '' };
  if (pathname === '/api/projects') return { projects: [fixtureProject] };
  if (pathname.endsWith('/schema')) return { types: ['Task', 'Feature', 'Bug', 'Chore'], statuses: ['open', 'in_progress', 'blocked', 'closed', 'canceled'] };
  if (/\/list(-all)?$/.test(pathname)) return { items: fixtureItems };
  if (pathname.includes('/get/')) return { item: fixtureItems.find(item => item.id === pathname.split('/').at(-1)) };
  if (pathname.endsWith('/calendar')) return { events: fixtureItems.slice(0, 3).map(item => ({ ...item, date: item.deadline })) };
  if (pathname.includes('/graph')) return { graph: { nodes: fixtureItems.map(item => ({ id: item.id, labels: ['Item'], properties: item })), relationships: [{ from: 'note-2', to: 'note-3', type: 'BLOCKED_BY' }, { from: 'note-1', to: 'note-2', type: 'DEPENDS_ON' }] } };
  if (pathname.endsWith('/extensions')) return { canManagePackages: true, packages: [
    { name: 'pm-graph', title: 'pm-graph', description: 'Explore relationships between items and their evidence.', commands: ['graph'], capabilities: ['Relationships'], category: 'extension', installed: true, version: '2026.10.14', active: true, enabled: true, runtimeActive: true, availability: 'published' },
    { name: 'pm-calendar', title: 'pm-calendar', description: 'Keep deadlines and scheduled work in view.', commands: ['calendar'], capabilities: ['Calendar'], category: 'extension', installed: false, version: null, availability: 'published' },
  ] };
  if (pathname.endsWith('/shares')) return { shares: [{ id: 'fixture-share', user_display_name: 'Alex', user_email: 'reviewer@example.test', permission: 'edit', shared_at: '2026-10-16T10:00:00Z' }] };
  if (pathname === '/api/admin/overview') return { users: [fixtureUser], projects: [{ ...fixtureProject, owner_email: fixtureUser.email }], groups: [], stats: { users: 1, admins: 1, projects: 1, sharedProjects: 1, groups: 0 }, serverVersion: 'fixture' };
  if (pathname.includes('/comments/')) return { comments: [{ text: 'The review is ready. Link the checks before closing this item.', timestamp: '2026-10-17T09:00:00Z' }] };
  if (pathname.includes('/history/')) return { history: [{ action: 'Created the item', timestamp: '2026-10-16T10:00:00Z' }, { action: 'Linked the release checklist', timestamp: '2026-10-17T09:00:00Z' }] };
  return { notes: [], deps: [], learnings: [], tests: [], files: [], entries: [], groups: [], items: [] };
}
