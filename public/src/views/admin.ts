import { api } from '../api.js';
import type { AdminGroup, AdminProject, AdminUser } from '../types.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';

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

let adminData: AdminOverview | null = null;

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
        <button class="btn btn-secondary btn-sm" onclick="window.__app.setAdminRole('${escHtml(user.id)}', ${user.is_admin ? 'false' : 'true'})">
          ${user.is_admin ? 'Remove Admin' : 'Make Admin'}
        </button>
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
    </tr>`;
}

function renderAdmin(data: AdminOverview): string {
  return `
    <div class="view-header">
      <div>
        <h1>Admin</h1>
        <p class="view-subtitle">User, project, sharing, GitHub, and group oversight for pm-web.</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary" onclick="window.__app.renderAdminView()">Refresh</button>
      </div>
    </div>

    <div class="admin-stats">
      <div class="stat-card"><div class="stat-value">${data.stats.users}</div><div class="stat-label">Users</div></div>
      <div class="stat-card"><div class="stat-value">${data.stats.admins}</div><div class="stat-label">Admins</div></div>
      <div class="stat-card"><div class="stat-value">${data.stats.projects}</div><div class="stat-label">Projects</div></div>
      <div class="stat-card"><div class="stat-value">${data.stats.sharedProjects}</div><div class="stat-label">Shares</div></div>
      <div class="stat-card"><div class="stat-value">${data.stats.groups}</div><div class="stat-label">Groups</div></div>
    </div>

    <section class="admin-panel">
      <div class="graph-panel-title">Users</div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>User</th><th>Role</th><th>GitHub</th><th>Created</th><th></th></tr></thead>
          <tbody>${data.users.map(renderUserRow).join('')}</tbody>
        </table>
      </div>
    </section>

    <section class="admin-panel">
      <div class="graph-panel-title">Projects</div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Project</th><th>Owner</th><th>GitHub Repo</th><th>Sync</th><th>Created</th></tr></thead>
          <tbody>${data.projects.map(renderProjectRow).join('')}</tbody>
        </table>
      </div>
    </section>

    <section class="admin-panel">
      <div class="graph-panel-title">Groups</div>
      <div class="admin-grid-list">
        ${data.groups.length === 0
          ? '<div class="empty-state"><div class="empty-state-text">No groups yet.</div></div>'
          : data.groups.map((group) => `
            <div class="admin-group-card">
              <strong>${escHtml(group.name)}</strong>
              <span>${escHtml(group.owner_email)} · ${group.member_count} members</span>
              ${group.description ? `<p>${escHtml(group.description)}</p>` : ''}
            </div>`).join('')}
      </div>
    </section>`;
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
