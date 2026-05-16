// ═══════════════════════════════════════════════════════════════
// HEALTH VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
export async function renderHealthView() {
    const el = document.getElementById('content-health');
    if (!el)
        return;
    if (!state.currentProject) {
        el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>';
        return;
    }
    el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Project Health</div><div class="page-subtitle">${escHtml(state.currentProject.name)}</div></div>
      <div class="page-actions"><button class="btn btn-secondary btn-sm" onclick="window.__app.renderHealthView()">↺ Refresh</button></div>
    </div>
    <div id="health-content"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;
    try {
        const data = await api('GET', `/projects/${state.currentProject.id}/pm/health`);
        const health = data.health || data;
        const score = health.score !== undefined ? health.score : null;
        const issues = health.issues || [];
        let scoreColor = '#4ade80';
        if (score !== null) {
            if (score < 50)
                scoreColor = '#f87171';
            else if (score < 80)
                scoreColor = '#facc15';
        }
        const contentEl = document.getElementById('health-content');
        if (!contentEl)
            return;
        contentEl.innerHTML = `
      ${score !== null ? `
        <div class="card" style="margin-bottom:16px">
          <div class="health-score-display">
            <div class="health-score-number" style="color:${scoreColor}">${score}</div>
            <div class="health-score-label">Health Score / 100</div>
          </div>
        </div>` : ''}
      <div class="card">
        <div class="card-header">
          <div class="card-title">Issues ${issues.length > 0 ? `(${issues.length})` : ''}</div>
        </div>
        <div class="card-body">
          ${issues.length === 0
            ? '<div style="color:var(--status-closed);font-size:13px">✓ No issues found — project looks healthy!</div>'
            : issues.map((i) => `<div class="health-issue-item">⚠ ${escHtml(i.message || i.description || String(i))}</div>`).join('')}
        </div>
      </div>
      ${health.summary ? `
        <div class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">Summary</div></div>
          <div class="card-body"><div class="item-detail-desc">${escHtml(health.summary)}</div></div>
        </div>` : ''}`;
    }
    catch (err) {
        const contentEl = document.getElementById('health-content');
        if (contentEl)
            contentEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
    }
}
//# sourceMappingURL=health.js.map