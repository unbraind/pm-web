// ═══════════════════════════════════════════════════════════════
// PROJECTS VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml, fmtDate } from '../utils.js';
import { showModal, hideModal, createModal, confirmDialog } from '../components/modals.js';
import { toast } from '../components/toast.js';
import { showView } from '../views/router.js';

export async function loadProjects(): Promise<void> {
  const data = await api('GET','/projects');
  state.projects = data.projects || [];
  renderProjectSelector();
}

export function renderProjectSelector(): void {
  const sel = document.getElementById('project-selector') as HTMLSelectElement | null;
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Select project —</option>' +
    state.projects.map(p=>`<option value="${p.id}"${p.id===cur?' selected':''}>${escHtml(p.name)}</option>`).join('');
}

async function fetchProjectSchema(projectId: string): Promise<void> {
  try {
    const schema = await api('GET', `/projects/${projectId}/pm/schema`);
    if (schema && Array.isArray(schema.types) && schema.types.length) {
      state.schema = schema as import('../types.js').ProjectSchema;
    }
  } catch (_) { /* fallback to constants */ }
}

export async function onProjectSelect(id: string): Promise<void> {
  if (!id) {
    state.currentProject = null;
    state.schema = null;
    (window as any).__app?.disconnectSSE?.();
    const pmSection = document.getElementById('sidebar-pm-section');
    if (pmSection) pmSection.style.display = 'none';
    showView('projects');
    return;
  }
  const proj = state.projects.find(p=>p.id===id);
  if (!proj) return;
  state.currentProject = proj;
  const pmSection = document.getElementById('sidebar-pm-section');
  if (pmSection) pmSection.style.display = '';
  const projName = document.getElementById('sidebar-project-name');
  if (projName) projName.textContent = proj.name;
  (window as any).__app?.connectSSE?.(proj.id);
  // Fetch schema in background — views use fallback until it resolves
  fetchProjectSchema(proj.id);
  showView('items');
  loadItemsBadge();
}

export async function loadItemsBadge(): Promise<void> {
  if (!state.currentProject) return;
  try {
    const data = await api('GET',`/projects/${state.currentProject.id}/pm/list?status=open&limit=200`);
    const count = (data.items||[]).length;
    const badge = document.getElementById('badge-items');
    if (badge) badge.textContent = count ? String(count) : '';
  } catch(_) { /* ignore */ }
}

export function renderProjectsView(): void {
  const el = document.getElementById('content-projects');
  if (!el) return;
  if (state.projects.length === 0) {
    el.innerHTML = `
      <div class="page-header">
        <div><div class="page-title">Projects</div><div class="page-subtitle">Your project workspaces</div></div>
        <div class="page-actions"><button class="btn btn-primary" onclick="window.__app.showModal('create-project-modal')">+ New Project</button></div>
      </div>
      <div class="welcome-state">
        <div class="welcome-icon">⊞</div>
        <div class="welcome-title">No projects yet</div>
        <div class="welcome-text">Create your first project to start managing tasks, features, bugs, and more with git-native storage.</div>
        <button class="btn btn-primary btn-lg" onclick="window.__app.showModal('create-project-modal')">+ Create Project</button>
      </div>`;
    return;
  }
  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Projects</div><div class="page-subtitle">${state.projects.length} project${state.projects.length!==1?'s':''}</div></div>
      <div class="page-actions"><button class="btn btn-primary" onclick="window.__app.showModal('create-project-modal')">+ New Project</button></div>
    </div>
    <div class="projects-grid">
      ${state.projects.map(p=>`
        <div class="project-card" onclick="window.__app.selectProject('${p.id}')">
          <button class="btn btn-ghost btn-sm project-card-del" onclick="event.stopPropagation();window.__app.deleteProject('${p.id}','${escHtml(p.name)}')" title="Delete project">✕</button>
          <div class="project-card-name">${escHtml(p.name)}</div>
          <div class="project-card-slug mono">${escHtml(p.slug)}</div>
          <div class="project-card-desc">${escHtml(p.description||'No description')}</div>
          <div class="project-card-meta">
            <span class="project-card-prefix">${escHtml(p.prefix)}</span>
            <span class="project-card-date">${fmtDate(p.created_at)}</span>
          </div>
        </div>`).join('')}
    </div>`;
}

export function selectProject(id: string): void {
  const sel = document.getElementById('project-selector') as HTMLSelectElement | null;
  if (sel) sel.value = id;
  onProjectSelect(id);
}

export function deleteProject(id: string, name: string): void {
  confirmDialog('Delete Project?', `Delete project "${name}"? This cannot be undone.`, async () => {
    try {
      await api('DELETE',`/projects/${id}`);
      toast('Project deleted','success');
      if (state.currentProject?.id === id) {
        state.currentProject = null;
        const pmSection = document.getElementById('sidebar-pm-section');
        if (pmSection) pmSection.style.display = 'none';
      }
      await loadProjects();
      if (state.currentView === 'projects') renderProjectsView();
    } catch(err: unknown) {
      toast(err instanceof Error ? err.message : String(err),'error');
    }
  }, true);
}

export function buildCreateProjectModal(): void {
  createModal('create-project-modal','New Project',`
    <form id="create-project-form" onsubmit="window.__app.submitCreateProject(event)">
      <div class="form-group">
        <label class="form-label">Project Name *</label>
        <input class="form-input" id="cp-name" type="text" placeholder="My Awesome Project" required>
      </div>
      <div class="form-group">
        <label class="form-label">ID Prefix *</label>
        <input class="form-input" id="cp-prefix" type="text" placeholder="myproj" pattern="[a-z0-9\\-]+" required>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Lowercase letters, numbers, hyphens. Used as item ID prefix (e.g. myproj-1)</div>
      </div>
      <div class="form-group">
        <label class="form-label">Description</label>
        <input class="form-input" id="cp-desc" type="text" placeholder="What is this project about?">
      </div>
      <div class="form-error" id="cp-error" style="display:none"></div>
    </form>`,
    `<button class="btn btn-ghost" onclick="window.__app.hideModal('create-project-modal')">Cancel</button>
     <button class="btn btn-primary" onclick="window.__app.submitCreateProject2()"><span>Create Project</span></button>`
  );

  const nameEl = document.getElementById('cp-name');
  const prefixEl = document.getElementById('cp-prefix') as (HTMLInputElement & { _touched?: boolean }) | null;
  if (nameEl && prefixEl) {
    nameEl.addEventListener('input', function() {
      const prefix = (this as HTMLInputElement).value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,20);
      if (!prefixEl._touched) prefixEl.value = prefix;
    });
    prefixEl.addEventListener('input', function() { (this as HTMLInputElement & { _touched?: boolean })._touched = !!(this as HTMLInputElement).value; });
  }
}

export async function submitCreateProject(e?: Event): Promise<void> {
  e?.preventDefault();
  await submitCreateProject2();
}

async function submitCreateProject2(): Promise<void> {
  const nameEl = document.getElementById('cp-name') as HTMLInputElement | null;
  const prefixEl = document.getElementById('cp-prefix') as HTMLInputElement | null;
  const descEl = document.getElementById('cp-desc') as HTMLInputElement | null;
  const errEl = document.getElementById('cp-error') as HTMLElement | null;
  if (!nameEl || !prefixEl || !errEl) return;

  const name = nameEl.value.trim();
  const prefix = prefixEl.value.trim();
  const desc = descEl?.value.trim() || '';
  errEl.style.display = 'none';
  if (!name || !prefix) { errEl.textContent = 'Name and prefix are required.'; errEl.style.display = 'block'; return; }
  try {
    const data = await api('POST','/projects',{name,prefix,description:desc});
    state.projects.unshift(data.project);
    renderProjectSelector();
    hideModal('create-project-modal');
    toast('Project created!','success');
    nameEl.value = '';
    prefixEl.value = '';
    (prefixEl as HTMLInputElement & { _touched?: boolean })._touched = false;
    if (descEl) descEl.value = '';
    if (state.currentView === 'projects') renderProjectsView();
  } catch(err: unknown) {
    errEl.textContent = err instanceof Error ? err.message : String(err);
    errEl.style.display = 'block';
  }
}

export { submitCreateProject2 };
