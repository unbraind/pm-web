// ═══════════════════════════════════════════════════════════════
// TEMPLATES VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml, typeIcon } from '../utils.js';
import { toast } from '../components/toast.js';
import { showView } from './router.js';
export async function renderTemplatesView() {
    const el = document.getElementById('content-templates');
    if (!el)
        return;
    if (!state.currentProject) {
        el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>';
        return;
    }
    el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Templates</div>
        <div class="page-subtitle">Reusable item templates for ${escHtml(state.currentProject.name)}</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" onclick="window.__app.renderTemplatesView()">↺ Refresh</button>
      </div>
    </div>
    <div id="templates-content"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;
    await fetchAndRenderTemplates();
}
async function fetchAndRenderTemplates() {
    const pid = state.currentProject?.id;
    if (!pid)
        return;
    try {
        const data = await api('GET', `/projects/${pid}/pm/templates`);
        const templates = data.templates || [];
        const el = document.getElementById('templates-content');
        if (!el)
            return;
        if (templates.length === 0) {
            el.innerHTML = `
        <div class="card">
          <div class="card-body">
            <div style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
              No templates defined yet. Create templates using the <code style="font-family:var(--font-mono);background:var(--bg-input);padding:2px 6px;border-radius:4px">pm templates create</code> CLI command.
            </div>
            <div style="font-size:12px;color:var(--text-secondary)">
              Templates allow you to pre-fill item fields (type, priority, tags, description, etc.) when creating new items.
            </div>
          </div>
        </div>`;
            return;
        }
        el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">
        ${templates.map((t) => renderTemplateCard(t)).join('')}
      </div>`;
    }
    catch (err) {
        const el = document.getElementById('templates-content');
        if (el)
            el.innerHTML = `<div class="empty-state"><div class="empty-state-text">Failed to load templates: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
    }
}
function renderTemplateCard(t) {
    const name = t.name || t.id || 'Unnamed';
    const type = t.type || t.defaults?.type || '';
    const priority = t.priority || t.defaults?.priority || '';
    const tags = (t.tags || t.defaults?.tags || []).join(', ');
    const desc = t.description || t.defaults?.description || '';
    return `
    <div class="card" style="cursor:default">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
        <div class="card-title" style="display:flex;align-items:center;gap:6px">
          ${type ? typeIcon(type) : ''}
          <span>${escHtml(name)}</span>
        </div>
        ${priority ? `<span style="font-size:11px;color:var(--text-muted);background:var(--bg-input);padding:2px 8px;border-radius:4px">P${priority}</span>` : ''}
      </div>
      <div class="card-body" style="padding-top:0">
        ${type ? `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">Type: <strong>${escHtml(type)}</strong></div>` : ''}
        ${tags ? `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">Tags: ${escHtml(tags)}</div>` : ''}
        ${desc ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;line-height:1.4">${escHtml(desc)}</div>` : ''}
        <button class="btn btn-primary btn-sm" style="width:100%" onclick="window.__app.createFromTemplate(${JSON.stringify(escHtml(name))}, ${JSON.stringify(t)})">
          + Create from Template
        </button>
      </div>
    </div>`;
}
export function createFromTemplate(name, template) {
    // Navigate to create view and pre-fill from template
    showView('create');
    // Give the create view time to render, then fill fields
    setTimeout(() => {
        const defaults = template.defaults || template;
        const setVal = (id, val) => {
            if (!val)
                return;
            const el = document.getElementById(id);
            if (el)
                el.value = val;
        };
        setVal('ci-type', defaults.type || template.type);
        setVal('ci-priority', String(defaults.priority || template.priority || ''));
        setVal('ci-tags', (defaults.tags || template.tags || []).join(', '));
        setVal('ci-desc', defaults.description || template.description || '');
        setVal('ci-sprint', defaults.sprint || template.sprint || '');
        setVal('ci-release', defaults.release || template.release || '');
        setVal('ci-assignee', defaults.assignee || template.assignee || '');
        if (defaults.acceptance_criteria || defaults.acceptanceCriteria) {
            setVal('ci-acceptance-criteria', defaults.acceptance_criteria || defaults.acceptanceCriteria);
        }
        toast(`Template "${name}" applied`, 'success');
        document.getElementById('ci-title')?.focus();
    }, 100);
}
//# sourceMappingURL=templates.js.map