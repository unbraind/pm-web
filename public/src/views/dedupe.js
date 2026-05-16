// ═══════════════════════════════════════════════════════════════
// DEDUPE AUDIT VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml, typeIcon, statusBadge } from '../utils.js';
export async function renderDedupeAuditView() {
    const el = document.getElementById('content-dedupe');
    if (!el)
        return;
    if (!state.currentProject) {
        el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>';
        return;
    }
    el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Dedupe Audit</div><div class="page-subtitle">Find potential duplicate items in ${escHtml(state.currentProject.name)}</div></div>
      <div class="page-actions"><button class="btn btn-secondary btn-sm" onclick="window.__app.renderDedupeAuditView()">↺ Refresh</button></div>
    </div>
    <div id="dedupe-content"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;
    try {
        const data = await api('GET', `/projects/${state.currentProject.id}/pm/dedupe-audit`);
        const groups = data.groups || data.duplicates || [];
        const el2 = document.getElementById('dedupe-content');
        if (!el2)
            return;
        if (groups.length === 0) {
            el2.innerHTML = `<div class="card"><div class="card-body"><div style="color:var(--status-closed);font-size:13px">✓ No potential duplicates found — project looks clean!</div></div></div>`;
        }
        else {
            el2.innerHTML = groups.map((g, i) => `
        <div class="card" style="margin-bottom:12px">
          <div class="card-header"><div class="card-title">Potential Duplicate Group ${i + 1} ${g.score !== undefined ? `<span style="font-size:11px;color:var(--text-muted)">· ${Math.round((g.score || 0) * 100)}% similarity</span>` : ''}</div></div>
          <div class="card-body">
            ${(g.items || []).map((item) => `
              <div class="item-row" onclick="window.__app.openItemDetail('${escHtml(item.id || item)}')" style="cursor:pointer">
                ${typeIcon(item.type || '')} <span class="item-id">${escHtml(item.id || item)}</span>
                <span class="item-title">${escHtml(item.title || '')}</span>
                <div class="item-meta">${statusBadge(item.status || 'draft')}</div>
              </div>`).join('')}
          </div>
        </div>`).join('') || `<div class="card"><div class="card-body"><pre style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap">${escHtml(JSON.stringify(data, null, 2))}</pre></div></div>`;
        }
    }
    catch (err) {
        const el2 = document.getElementById('dedupe-content');
        if (el2)
            el2.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
    }
}
//# sourceMappingURL=dedupe.js.map