import { api } from '../api.js';
import type { AdminGroup, AdminProject, AdminUser } from '../types.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';
import { confirmDialog } from '../components/modals.js';

type AdminOverview = {
  users: AdminUser[];
  projects: AdminProject[];
  groups: AdminGroup[];
  stats: {
    users: number;
    admins: number;
    projects: number;
    sharedProjects: number;
    groups: number;
  };
};

type AuditEntry = {
  id?: string;
  action?: string;
  userId?: string;
  userEmail?: string;
  target?: string;
  details?: string;
  created_at?: string;
  timestamp?: string;
};

let adminData: AdminOverview | null = null;
let adminTab: 'users' | 'projects' | 'groups' | 'audit' = 'users';
let userFilter = '';
let projectFilter = '';
let auditEntries: AuditEntry[] = [];
let auditFilter = '';
let currentPage = 1;
const PAGE_SIZE = 20;

function paginate<T>(items: T[], page: number): T[] {
  const start = (page - 1) * PAGE_SIZE;
  return items.slice(start, start + PAGE_SIZE);
}

function renderPagination(totalItems: number, currentPg: number, hook: string): string {
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  if (totalPages <= 1) return '';
  return `
    <div class="admin-pagination" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;font-size:12px;color:var(--text-muted)">
      <span>Page ${currentPg} of ${totalPages} (${totalItems} items)</span>
      <div style="display:flex;gap:4px">
        <button class="btn btn-sm btn-secondary" ${currentPg <= 1 ? 'disabled' : ''} onclick="window.__app.adminSetPage(${currentPg - 1})" aria-label="Previous page">← Prev</button>
        <button class="btn btn-sm btn-secondary" ${currentPg >= totalPages ? 'disabled' : ''} onclick="window.__app.adminSetPage(${currentPg + 1})" aria-label="Next page">Next →</button>
      </div>
    </div>`;
}

function renderUserRow(user: AdminUser): string {
  return `
    <tr>
      <td>
        <strong>${escHtml(user.display_name || user.email)}</strong>
        <span>${escHtml(user.email)}</span>
      </td>
      <td>${user.is_admin ? '<span class="admin-pill admin-pill-strong">Admin</span>' : '<span class="admin-pill">User</span>'}</td>
      <td>${user.has_github_token ? 'Connected' : 'Not connected'}</td>
      <td>${new Date(user.created_at).toLocaleDateString()}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" onclick="window.__app.setAdminRole('${escHtml(user.id)}', ${user.is_admin ? 'false' : 'true'})" aria-label="${user.is_admin ? 'Remove admin role' : 'Make admin'}">
            ${user.is_admin ? 'Remove Admin' : 'Make Admin'}
          </button>
          <button class="btn btn-danger btn-sm" onclick="window.__app.adminDeleteUser('${escHtml(user.id)}','${escHtml(user.display_name || user.email)}')" aria-label="Delete user ${escHtml(user.display_name || user.email)}">
            Delete
          </button>
        </div>
      </td>
    </tr>`;
}

function renderProjectRow(project: AdminProject): string {
  const repo = project.github_owner && project.github_repo ? `${project.github_owner}/${project.github_repo}` : 'Not linked';
  return `
    <tr>
      <td>
        <strong>${escHtml(project.name)}</strong>
        <span>${escHtml(project.slug)} · ${escHtml(project.prefix)}</span>
      </td>
      <td>${escHtml(project.owner_display_name || project.owner_email)}</td>
      <td>${escHtml(repo)}</td>
      <td>${project.github_sync_enabled ? '<span class="admin-pill admin-pill-strong">Sync on</span>' : '<span class="admin-pill">Sync off</span>'}</td>
      <td>${new Date(project.created_at).toLocaleDateString()}</td>
      <td>
        <button class="btn btn-danger btn-sm" onclick="window.__app.adminDeleteProject('${escHtml(project.id)}','${escHtml(project.name)}')" aria-label="Delete project ${escHtml(project.name)}">
          Delete
        </button>
      </td>
    </tr>`;
}

function renderAuditRow(entry: AuditEntry): string {
  return `
    <tr>
      <td style="white-space:nowrap">${escHtml(entry.userEmail || entry.userId || '—')}</td>
      <td><span class="admin-pill">${escHtml(entry.action || '—')}</span></td>
      <td>${escHtml(entry.target || '—')}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${escHtml(entry.details || '—')}</td>
      <td style="white-space:nowrap">${entry.created_at ? new Date(entry.created_at).toLocaleString() : entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '—'}</td>
    </tr>`;
}

function renderGroupCard(group: AdminGroup): string {
  return `
    <div class="admin-group-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <strong>${escHtml(group.name)}</strong>
        <button class="btn btn-danger btn-sm" onclick="window.__app.adminDeleteGroup('${escHtml(group.id)}','${escHtml(group.name)}')" aria-label="Delete group ${escHtml(group.name)}" style="flex-shrink:0">Delete</button>
      </div>
      <span>${escHtml(group.owner_email)} · ${group.member_count} members</span>
      ${group.description ? `<p>${escHtml(group.description)}</p>` : ''}
    </div>`;
}

function renderAdmin(data: AdminOverview): string {
  // Filter users
  const filteredUsers = data.users.filter(u =>
    !userFilter || u.email.toLowerCase().includes(userFilter.toLowerCase()) || (u.display_name || '').toLowerCase().includes(userFilter.toLowerCase())
  );
  const pagedUsers = paginate(filteredUsers, adminTab === 'users' ? currentPage : 1);

  // Filter projects
  const filteredProjects = data.projects.filter(p =>
    !projectFilter || p.name.toLowerCase().includes(projectFilter.toLowerCase()) || p.slug.toLowerCase().includes(projectFilter.toLowerCase()) || p.owner_email.toLowerCase().includes(projectFilter.toLowerCase())
  );
  const pagedProjects = paginate(filteredProjects, adminTab === 'projects' ? currentPage : 1);

  // Filter audit
  const filteredAudit = auditEntries.filter(e =>
    !auditFilter ||
    (e.action || '').toLowerCase().includes(auditFilter.toLowerCase()) ||
    (e.userEmail || '').toLowerCase().includes(auditFilter.toLowerCase()) ||
    (e.target || '').toLowerCase().includes(auditFilter.toLowerCase()) ||
    (e.details || '').toLowerCase().includes(auditFilter.toLowerCase())
  );
  const pagedAudit = paginate(filteredAudit, adminTab === 'audit' ? currentPage : 1);

  const tabs = [
    { id: 'users' as const, label: 'Users', count: filteredUsers.length },
    { id: 'projects' as const, label: 'Projects', count: filteredProjects.length },
    { id: 'groups' as const, label: 'Groups', count: data.groups.length },
    { id: 'audit' as const, label: 'Audit Log', count: filteredAudit.length },
  ];

  return `
    <div class="view-header">
      <div>
        <h1>Admin</h1>
        <p class="view-subtitle">User, project, sharing, GitHub, and group oversight for pm-web.</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary" onclick="window.__app.renderAdminView()" aria-label="Refresh admin data">Refresh</button>
      </div>
    </div>

    <div class="admin-stats">
      <div class="stat-card"><div class="stat-value">${data.stats.users}</div><div class="stat-label">Users</div></div>
      <div class="stat-card"><div class="stat-value">${data.stats.admins}</div><div class="stat-label">Admins</div></div>
      <div class="stat-card"><div class="stat-value">${data.stats.projects}</div><div class="stat-label">Projects</div></div>
      <div class="stat-card"><div class="stat-value">${data.stats.sharedProjects}</div><div class="stat-label">Shares</div></div>
      <div class="stat-card"><div class="stat-value">${data.stats.groups}</div><div class="stat-label">Groups</div></div>
    </div>

    <div class="tabs" role="tablist">
      ${tabs.map(t => `<div class="tab${adminTab === t.id ? ' active' : ''}" role="tab" aria-selected="${adminTab === t.id}" tabindex="0" onclick="window.__app.adminSwitchTab('${t.id}')" onkeydown="if(event.key==='Enter')window.__app.adminSwitchTab('${t.id}')">${escHtml(t.label)} (${t.count})</div>`).join('')}
    </div>

    ${adminTab === 'users' ? `
    <section class="admin-panel" aria-label="Users management">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <div class="graph-panel-title" style="margin-bottom:0">Users</div>
        <div class="search-box-wrap" style="margin-bottom:0;max-width:300px;flex:1">
          <span class="search-icon">⌕</span>
          <input class="search-input" type="text" placeholder="Filter users…" value="${escHtml(userFilter)}" oninput="window.__app.adminFilterUsers(this.value)" aria-label="Filter users">
        </div>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table" role="table">
          <thead><tr><th>User</th><th>Role</th><th>GitHub</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>${pagedUsers.map(renderUserRow).join('')}</tbody>
        </table>
      </div>
      ${renderPagination(filteredUsers.length, currentPage, 'users')}
    </section>` : ''}

    ${adminTab === 'projects' ? `
    <section class="admin-panel" aria-label="Projects management">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <div class="graph-panel-title" style="margin-bottom:0">Projects</div>
        <div class="search-box-wrap" style="margin-bottom:0;max-width:300px;flex:1">
          <span class="search-icon">⌕</span>
          <input class="search-input" type="text" placeholder="Filter projects…" value="${escHtml(projectFilter)}" oninput="window.__app.adminFilterProjects(this.value)" aria-label="Filter projects">
        </div>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table" role="table">
          <thead><tr><th>Project</th><th>Owner</th><th>GitHub Repo</th><th>Sync</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>${pagedProjects.map(renderProjectRow).join('')}</tbody>
        </table>
      </div>
      ${renderPagination(filteredProjects.length, currentPage, 'projects')}
    </section>` : ''}

    ${adminTab === 'groups' ? `
    <section class="admin-panel" aria-label="Groups management">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div class="graph-panel-title" style="margin-bottom:0">Groups</div>
        <button class="btn btn-primary btn-sm" onclick="window.__app.adminCreateGroupPrompt()" aria-label="Create new group">+ New Group</button>
      </div>
      <div class="admin-grid-list">
        ${data.groups.length === 0
          ? '<div class="empty-state"><div class="empty-state-text">No groups yet.</div></div>'
          : data.groups.map(renderGroupCard).join('')}
      </div>
    </section>` : ''}

    ${adminTab === 'audit' ? `
    <section class="admin-panel" aria-label="Audit log">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <div class="graph-panel-title" style="margin-bottom:0">Audit Log</div>
        <div class="search-box-wrap" style="margin-bottom:0;max-width:300px;flex:1">
          <span class="search-icon">⌕</span>
          <input class="search-input" type="text" placeholder="Filter audit log…" value="${escHtml(auditFilter)}" oninput="window.__app.adminFilterAudit(this.value)" aria-label="Filter audit log">
        </div>
      </div>
      ${filteredAudit.length === 0
        ? '<div class="empty-state"><div class="empty-state-text">No audit entries found.</div></div>'
        : `<div class="admin-table-wrap">
        <table class="admin-table" role="table">
          <thead><tr><th>User</th><th>Action</th><th>Target</th><th>Details</th><th>Time</th></tr></thead>
          <tbody>${pagedAudit.map(renderAuditRow).join('')}</tbody>
        </table>
      </div>
      ${renderPagination(filteredAudit.length, currentPage, 'audit')}`}
    </section>` : ''}`;
}

export async function renderAdminView(): Promise<void> {
  const el = document.getElementById('content-admin');
  if (!el) return;
  el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  try {
    adminData = await api('GET', '/admin/overview') as AdminOverview;
    el.innerHTML = renderAdmin(adminData);
  } catch (err: unknown) {
    el.innerHTML = `<div class="empty-state"><div class="empty-state-text">Admin failed: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

export async function setAdminRole(userId: string, isAdmin: boolean): Promise<void> {
  try {
    await api('PATCH', `/admin/users/${encodeURIComponent(userId)}`, { isAdmin });
    toast('Admin role updated', 'success');
    await renderAdminView();
  } catch (err: unknown) {
    toast(err instanceof Error ? err.message : String(err), 'error');
  }
}

export function adminSwitchTab(tab: 'users' | 'projects' | 'groups' | 'audit'): void {
  adminTab = tab;
  currentPage = 1;
  if (adminData) {
    const el = document.getElementById('content-admin');
    if (el) el.innerHTML = renderAdmin(adminData);
  }
}

export function adminFilterUsers(filter: string): void {
  userFilter = filter;
  currentPage = 1;
  if (adminData) {
    const el = document.getElementById('content-admin');
    if (el) el.innerHTML = renderAdmin(adminData);
  }
}

export function adminFilterProjects(filter: string): void {
  projectFilter = filter;
  currentPage = 1;
  if (adminData) {
    const el = document.getElementById('content-admin');
    if (el) el.innerHTML = renderAdmin(adminData);
  }
}

export function adminFilterAudit(filter: string): void {
  auditFilter = filter;
  currentPage = 1;
  if (adminData) {
    const el = document.getElementById('content-admin');
    if (el) el.innerHTML = renderAdmin(adminData);
  }
}

export function adminSetPage(page: number): void {
  currentPage = page;
  if (adminData) {
    const el = document.getElementById('content-admin');
    if (el) el.innerHTML = renderAdmin(adminData);
  }
}

export async function adminDeleteUser(userId: string, userName: string): Promise<void> {
  confirmDialog(
    `Delete user "${userName}"?`,
    'This action cannot be undone. The user will be permanently removed.',
    async () => {
      try {
        await api('DELETE', `/admin/users/${encodeURIComponent(userId)}`);
        toast('User deleted', 'success');
        await renderAdminView();
      } catch (err: unknown) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    true
  );
}

export async function adminDeleteProject(projectId: string, projectName: string): Promise<void> {
  confirmDialog(
    `Delete project "${projectName}"?`,
    'This will permanently delete the project and all its items. This action cannot be undone.',
    async () => {
      try {
        await api('DELETE', `/admin/projects/${encodeURIComponent(projectId)}`);
        toast('Project deleted', 'success');
        await renderAdminView();
      } catch (err: unknown) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    true
  );
}

export async function adminDeleteGroup(groupId: string, groupName: string): Promise<void> {
  confirmDialog(
    `Delete group "${groupName}"?`,
    'This will permanently remove the group and all its memberships.',
    async () => {
      try {
        await api('DELETE', `/admin/groups/${encodeURIComponent(groupId)}`);
        toast('Group deleted', 'success');
        await renderAdminView();
      } catch (err: unknown) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    true
  );
}

export function adminCreateGroupPrompt(): void {
  const id = 'admin-create-group-' + Date.now();
  const { createModal, showModal } = require_or_import_modals();
  createModal(id, 'Create Group', `
    <div class="form-group">
      <label class="form-label" for="admin-group-name">Group Name</label>
      <input class="form-input" id="admin-group-name" type="text" placeholder="e.g. Engineering" required aria-required="true">
    </div>
    <div class="form-group">
      <label class="form-label" for="admin-group-desc">Description</label>
      <input class="form-input" id="admin-group-desc" type="text" placeholder="Optional description">
    </div>
    <div class="form-error" id="admin-group-error" style="display:none"></div>
  `, `<button class="btn btn-primary" id="${id}-submit">Create Group</button>`);
  showModal(id);
  document.getElementById(`${id}-submit`)?.addEventListener('click', async () => {
    const name = (document.getElementById('admin-group-name') as HTMLInputElement)?.value?.trim();
    const desc = (document.getElementById('admin-group-desc') as HTMLInputElement)?.value?.trim();
    const errEl = document.getElementById('admin-group-error');
    if (!name) { if (errEl) { errEl.textContent = 'Group name is required'; errEl.style.display = 'block'; } return; }
    try {
      await api('POST', '/admin/groups', { name, description: desc });
      toast('Group created', 'success');
      const { hideModal } = require_or_import_modals();
      hideModal(id);
      await renderAdminView();
    } catch (err: unknown) {
      if (errEl) { errEl.textContent = err instanceof Error ? err.message : String(err); errEl.style.display = 'block'; }
    }
  });
}

// Avoid circular import at module level — lazy load modals helpers
function require_or_import_modals() {
  // We can't use dynamic import easily here (sync context), so inline the references
  // These are already imported at top level via confirmDialog
  return {
    createModal: (id: string, title: string, body: string, footer: string) => {
      const { createModal: cm } = require_modals_sync();
      return cm(id, title, body, footer);
    },
    showModal: (id: string) => {
      document.getElementById(id) && ((document.getElementById(id) as HTMLElement).style.display = 'flex');
    },
    hideModal: (id: string) => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    },
  };
}

function require_modals_sync() {
  // Use the imported createModal from top-level import
  return { createModal: _createModalImpl };
}

function _createModalImpl(id: string, title: string, bodyHtml: string, footerHtml: string): HTMLElement {
  let existing = document.getElementById(id);
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = id;
  el.className = 'modal-backdrop';
  el.style.display = 'none';
  el.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">${escHtml(title)}</div>
        <button class="modal-close" onclick="window.__app.hideModal('${id}')" aria-label="Close dialog">&times;</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
    </div>`;
  el.addEventListener('click', e => { if (e.target === el) el.style.display = 'none'; });
  const container = document.getElementById('modal-container');
  if (container) container.appendChild(el);
  return el;
}
