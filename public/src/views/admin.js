import { api } from '../api.js';
import { state } from '../state.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';
import { confirmDialog, createModal, showModal, hideModal } from '../components/modals.js';
function getAuditActor(entry) {
    return entry.actor_name || entry.actor_email || entry.userId || entry.userEmail || '—';
}
function normalizeAuditEntries(entries) {
    return entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        actor_email: entry.actor_email,
        actor_name: entry.actor_name,
        description: entry.description,
        created_at: entry.created_at,
    }));
}
function getAuditDescription(entry) {
    if (entry.description)
        return entry.description;
    if (entry.userId && entry.action)
        return `${entry.action} by ${entry.userId}`;
    if (entry.action)
        return entry.action;
    return '—';
}
let adminData = null;
let adminTab = 'users';
let userFilter = '';
let projectFilter = '';
let auditEntries = [];
let auditFilter = '';
let currentPage = 1;
const PAGE_SIZE = 20;
let adminAuditTotal = 0;
async function loadAuditData(page = 1) {
    if (!state.user?.is_admin)
        return;
    const safePage = Math.max(1, page);
    const offset = (safePage - 1) * PAGE_SIZE;
    const data = await api('GET', `/admin/audit?limit=${PAGE_SIZE}&offset=${offset}`);
    auditEntries = normalizeAuditEntries(data.entries || []);
    adminAuditTotal = data.total || 0;
    currentPage = safePage;
}
function paginate(items, page) {
    const start = (page - 1) * PAGE_SIZE;
    return items.slice(start, start + PAGE_SIZE);
}
function renderPagination(totalItems, currentPg, hook) {
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
    if (totalPages <= 1)
        return '';
    return `
    <div class="admin-pagination" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;font-size:12px;color:var(--text-muted)">
      <span>Page ${currentPg} of ${totalPages} (${totalItems} items)</span>
      <div style="display:flex;gap:4px">
        <button class="btn btn-sm btn-secondary" ${currentPg <= 1 ? 'disabled' : ''} onclick="window.__app.adminSetPage(${currentPg - 1})" aria-label="Previous page">← Prev</button>
        <button class="btn btn-sm btn-secondary" ${currentPg >= totalPages ? 'disabled' : ''} onclick="window.__app.adminSetPage(${currentPg + 1})" aria-label="Next page">Next →</button>
      </div>
    </div>`;
}
function renderUserRow(user) {
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
function renderProjectRow(project) {
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
function renderAuditRow(entry) {
    const actor = getAuditActor(entry);
    const details = getAuditDescription(entry);
    return `
    <tr>
      <td style="white-space:nowrap">${escHtml(actor)}</td>
      <td><span class="admin-pill">${escHtml(entry.action || '—')}</span></td>
      <td>${escHtml(entry.target || '—')}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${escHtml(details || '—')}</td>
      <td style="white-space:nowrap">${entry.created_at ? new Date(entry.created_at).toLocaleString() : entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '—'}</td>
    </tr>`;
}
function renderGroupCard(group) {
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
function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0)
        return `${h}h ${m}m`;
    return `${m}m`;
}
function renderAdmin(data) {
    // Filter users
    const filteredUsers = data.users.filter(u => !userFilter || u.email.toLowerCase().includes(userFilter.toLowerCase()) || (u.display_name || '').toLowerCase().includes(userFilter.toLowerCase()));
    const pagedUsers = paginate(filteredUsers, adminTab === 'users' ? currentPage : 1);
    // Filter projects
    const filteredProjects = data.projects.filter(p => !projectFilter || p.name.toLowerCase().includes(projectFilter.toLowerCase()) || p.slug.toLowerCase().includes(projectFilter.toLowerCase()) || p.owner_email.toLowerCase().includes(projectFilter.toLowerCase()));
    const pagedProjects = paginate(filteredProjects, adminTab === 'projects' ? currentPage : 1);
    // Filter audit
    const filteredAudit = auditEntries.filter(e => !auditFilter ||
        (e.action || '').toLowerCase().includes(auditFilter.toLowerCase()) ||
        (e.userEmail || '').toLowerCase().includes(auditFilter.toLowerCase()) ||
        (e.target || '').toLowerCase().includes(auditFilter.toLowerCase()) ||
        (e.details || '').toLowerCase().includes(auditFilter.toLowerCase()));
    const pagedAudit = adminTab === 'audit' ? filteredAudit : [];
    const tabs = [
        { id: 'users', label: 'Users', count: filteredUsers.length },
        { id: 'projects', label: 'Projects', count: filteredProjects.length },
        { id: 'groups', label: 'Groups', count: data.groups.length },
        { id: 'audit', label: 'Audit Log', count: adminAuditTotal },
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
      <div class="stat-card"><div class="stat-icon">◉</div><div class="stat-value">${data.stats.users}</div><div class="stat-label">Users</div></div>
      <div class="stat-card"><div class="stat-icon">◇</div><div class="stat-value">${data.stats.admins}</div><div class="stat-label">Admins</div></div>
      <div class="stat-card"><div class="stat-icon">⊞</div><div class="stat-value">${data.stats.projects}</div><div class="stat-label">Projects</div></div>
      <div class="stat-card"><div class="stat-icon">⇄</div><div class="stat-value">${data.stats.sharedProjects}</div><div class="stat-label">Shares</div></div>
      <div class="stat-card"><div class="stat-icon">◈</div><div class="stat-value">${data.stats.groups}</div><div class="stat-label">Groups</div></div>
      ${data.uptimeSeconds !== undefined ? `<div class="stat-card"><div class="stat-icon">◎</div><div class="stat-value">${formatUptime(data.uptimeSeconds)}</div><div class="stat-label">Uptime</div></div>` : ''}
      ${data.serverVersion ? `<div class="stat-card"><div class="stat-icon">◫</div><div class="stat-value">v${escHtml(data.serverVersion)}</div><div class="stat-label">Version</div></div>` : ''}
      <div class="stat-card"><div class="stat-icon">◷</div><div class="stat-value" style="font-size:12px">${new Date().toLocaleTimeString()}</div><div class="stat-label">Last Refreshed</div></div>
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
        <button class="btn btn-primary btn-sm" onclick="window.__app.adminCreateGroup()" aria-label="Create new group">+ New Group</button>
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
      ${renderPagination(adminAuditTotal, currentPage, 'audit')}`}
    </section>` : ''}`;
}
export async function renderAdminView() {
    const el = document.getElementById('content-admin');
    if (!el)
        return;
    if (!state.user?.is_admin) {
        el.innerHTML = `<div class="empty-state"><div class="empty-state-text">Admin access is required to view this page.</div></div>`;
        return;
    }
    el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
    try {
        adminData = await api('GET', '/admin/overview');
        if (adminTab === 'audit') {
            await loadAuditData(currentPage);
        }
        el.innerHTML = renderAdmin(adminData);
    }
    catch (err) {
        el.innerHTML = `<div class="empty-state"><div class="empty-state-text">Admin failed: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
    }
}
export async function setAdminRole(userId, isAdmin) {
    try {
        await api('PATCH', `/admin/users/${encodeURIComponent(userId)}`, { isAdmin });
        toast('Admin role updated', 'success');
        await renderAdminView();
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
    }
}
export function adminSwitchTab(tab) {
    adminTab = tab;
    currentPage = 1;
    if (tab === 'audit') {
        void loadAuditData(1).then(() => {
            const el = document.getElementById('content-admin');
            if (adminData && el)
                el.innerHTML = renderAdmin(adminData);
        }).catch((err) => {
            const el = document.getElementById('content-admin');
            if (el)
                el.innerHTML = `<div class="empty-state"><div class="empty-state-text">Failed to load audit log: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
        });
        return;
    }
    const el = document.getElementById('content-admin');
    if (el && adminData) {
        el.innerHTML = renderAdmin(adminData);
    }
}
export function adminFilterUsers(filter) {
    userFilter = filter;
    currentPage = 1;
    if (adminData) {
        const el = document.getElementById('content-admin');
        if (el)
            el.innerHTML = renderAdmin(adminData);
    }
}
export function adminFilterProjects(filter) {
    projectFilter = filter;
    currentPage = 1;
    if (adminData) {
        const el = document.getElementById('content-admin');
        if (el)
            el.innerHTML = renderAdmin(adminData);
    }
}
export function adminFilterAudit(filter) {
    auditFilter = filter;
    currentPage = 1;
    if (adminData) {
        const el = document.getElementById('content-admin');
        if (adminTab === 'audit') {
            void loadAuditData(1).then(() => {
                if (el)
                    el.innerHTML = renderAdmin(adminData);
            }).catch((err) => {
                if (el)
                    el.innerHTML = `<div class="empty-state"><div class="empty-state-text">Failed to reload audit log: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
            });
            return;
        }
        if (el)
            el.innerHTML = renderAdmin(adminData);
    }
}
export async function adminSetPage(page) {
    if (page < 1)
        return;
    if (!adminData)
        return;
    if (adminTab === 'audit') {
        await loadAuditData(page);
        const el = document.getElementById('content-admin');
        if (el)
            el.innerHTML = renderAdmin(adminData);
        return;
    }
    const userFilterLower = userFilter.toLowerCase();
    const projectFilterLower = projectFilter.toLowerCase();
    const filtered = adminTab === 'users'
        ? adminData.users.filter((u) => !userFilter || u.email.toLowerCase().includes(userFilterLower) || (u.display_name || '').toLowerCase().includes(userFilterLower))
        : adminData.projects.filter((p) => !projectFilter || p.name.toLowerCase().includes(projectFilterLower) || p.slug.toLowerCase().includes(projectFilterLower) || p.owner_email.toLowerCase().includes(projectFilterLower));
    const totalPages = Math.max(1, Math.ceil((filtered?.length || 0) / PAGE_SIZE));
    currentPage = Math.min(page, totalPages);
    const el = document.getElementById('content-admin');
    if (el)
        el.innerHTML = renderAdmin(adminData);
}
export async function adminDeleteUser(userId, userName) {
    confirmDialog(`Delete user "${userName}"?`, 'This action cannot be undone. The user will be permanently removed.', async () => {
        try {
            await api('DELETE', `/admin/users/${encodeURIComponent(userId)}`);
            toast('User deleted', 'success');
            await renderAdminView();
        }
        catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'error');
        }
    }, true);
}
export async function adminDeleteProject(projectId, projectName) {
    confirmDialog(`Delete project "${projectName}"?`, 'This will permanently delete the project and all its items. This action cannot be undone.', async () => {
        try {
            await api('DELETE', `/admin/projects/${encodeURIComponent(projectId)}`);
            toast('Project deleted', 'success');
            await renderAdminView();
        }
        catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'error');
        }
    }, true);
}
export async function adminDeleteGroup(groupId, groupName) {
    confirmDialog(`Delete group "${groupName}"?`, 'This will permanently remove the group and all its memberships.', async () => {
        try {
            await api('DELETE', `/admin/groups/${encodeURIComponent(groupId)}`);
            toast('Group deleted', 'success');
            await renderAdminView();
        }
        catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'error');
        }
    }, true);
}
export function adminCreateGroup() {
    const id = 'admin-create-group-' + Date.now();
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
        const name = document.getElementById('admin-group-name')?.value?.trim();
        const desc = document.getElementById('admin-group-desc')?.value?.trim();
        const errEl = document.getElementById('admin-group-error');
        if (!name) {
            if (errEl) {
                errEl.textContent = 'Group name is required';
                errEl.style.display = 'block';
            }
            return;
        }
        try {
            await api('POST', '/admin/groups', { name, description: desc });
            toast('Group created', 'success');
            hideModal(id);
            await renderAdminView();
        }
        catch (err) {
            if (errEl) {
                errEl.textContent = err instanceof Error ? err.message : String(err);
                errEl.style.display = 'block';
            }
        }
    });
}
//# sourceMappingURL=admin.js.map