import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { skeletonCards } from '../utils.js';
export async function renderSharedView() {
    const el = document.getElementById('content-shared');
    if (!el)
        return;
    el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Shared with Me</div><div class="page-subtitle">Projects others have shared with you</div></div>
      <div class="page-actions"><button class="btn btn-secondary btn-sm" onclick="window.__app.renderSharedView()">↺ Refresh</button></div>
    </div>
    <div id="shared-content">${skeletonCards(3)}</div>`;
    try {
        const data = await api('GET', '/shared');
        const projects = data.projects || [];
        const el2 = document.getElementById('shared-content');
        if (!el2)
            return;
        if (projects.length === 0) {
            el2.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">⇄</div>
          <div class="empty-state-text">No shared projects yet</div>
          <div class="empty-state-sub">When someone shares a project with you, it will appear here</div>
        </div>`;
            return;
        }
        el2.innerHTML = `
      <div class="projects-grid">
        ${projects.map((p) => `
          <div class="project-card" onclick="window.__app.selectProject('${p.id}')">
            <div class="project-card-name">${escHtml(p.name)}</div>
            <div class="project-card-slug mono">${escHtml(p.slug)}</div>
            <div class="project-card-desc">${escHtml(p.description || 'No description')}</div>
            <div class="project-card-meta">
              <span class="share-perm">${escHtml(p.permission || 'view')}</span>
              <span class="project-card-date">by ${escHtml(p.owner_display_name || p.owner_email || 'Unknown')}</span>
            </div>
          </div>`).join('')}
      </div>`;
    }
    catch (err) {
        const el2 = document.getElementById('shared-content');
        if (el2)
            el2.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
    }
}
//# sourceMappingURL=shared.js.map