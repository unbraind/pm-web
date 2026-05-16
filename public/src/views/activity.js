// ═══════════════════════════════════════════════════════════════
// ACTIVITY VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml, relTime } from '../utils.js';
import { TYPE_ICONS } from '../constants.js';
export async function renderActivityView() {
    const el = document.getElementById('content-activity');
    if (!el)
        return;
    if (!state.currentProject) {
        el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>';
        return;
    }
    el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Activity</div><div class="page-subtitle">Recent changes in ${escHtml(state.currentProject.name)}</div></div>
      <div class="page-actions"><button class="btn btn-secondary btn-sm" onclick="window.__app.renderActivityView()">↺ Refresh</button></div>
    </div>
    <div class="card"><div class="card-body" id="activity-list"><div class="loading-state"><div class="loading-spinner"></div></div></div></div>`;
    try {
        const data = await api('GET', `/projects/${state.currentProject.id}/pm/activity?limit=50`);
        const items = data.activity || data.items || [];
        const listEl = document.getElementById('activity-list');
        if (!listEl)
            return;
        if (items.length === 0) {
            listEl.innerHTML = `<div class="empty-state"><div class="empty-state-icon">◎</div><div class="empty-state-text">No activity yet</div></div>`;
            return;
        }
        listEl.innerHTML = items.map((a) => `
      <div class="activity-item">
        <div class="activity-icon">${TYPE_ICONS[a.type] || '◎'}</div>
        <div class="activity-body">
          <div class="activity-desc">${escHtml(a.message || a.title || a.action || JSON.stringify(a))}</div>
          <div class="activity-time">${relTime(a.timestamp || a.created_at)} ${a.id ? `· <span class="mono" style="font-size:11px">${escHtml(a.id)}</span>` : ''}</div>
        </div>
      </div>`).join('');
    }
    catch (err) {
        const listEl = document.getElementById('activity-list');
        if (listEl)
            listEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
    }
}
//# sourceMappingURL=activity.js.map