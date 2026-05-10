// ═══════════════════════════════════════════════════════════════
// CONTEXT VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml, relTime, typeIcon, statusBadge } from '../utils.js';
import { TYPE_ICONS } from '../constants.js';

export async function renderContextView(): Promise<void> {
  const el = document.getElementById('content-context');
  if (!el) return;
  if (!state.currentProject) { el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>'; return; }
  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Context</div><div class="page-subtitle">Project snapshot for ${escHtml(state.currentProject.name)}</div></div>
      <div class="page-actions"><button class="btn btn-secondary btn-sm" onclick="window.__app.renderContextView()">↺ Refresh</button></div>
    </div>
    <div id="context-content"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;

  try {
    const data = await api('GET',`/projects/${state.currentProject.id}/pm/context`);
    const ctx = (data as any).context || data;
    const contentEl = document.getElementById('context-content');
    if (contentEl) contentEl.innerHTML = renderContextData(ctx);
  } catch(err: unknown) {
    const contentEl = document.getElementById('context-content');
    if (contentEl) contentEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

function renderContextData(ctx: any): string {
  if (!ctx || typeof ctx !== 'object') {
    return `<div class="card"><div class="card-body"><div class="context-block">${escHtml(JSON.stringify(ctx,null,2))}</div></div></div>`;
  }

  const sections: string[] = [];

  if (ctx.summary || ctx.description) {
    sections.push(`<div class="context-section">
      <div class="context-section-title">◈ Summary</div>
      <div class="item-detail-desc">${escHtml(ctx.summary||ctx.description)}</div>
    </div>`);
  }

  const activeItems = ctx.activeItems || ctx.inProgress || ctx.open || [];
  if (activeItems.length > 0) {
    sections.push(`<div class="context-section">
      <div class="context-section-title">⚡ Active Items (${activeItems.length})</div>
      <div class="card"><div class="card-body">
        ${activeItems.map((item: any)=>`
          <div class="context-item-row">
            ${typeIcon(item.type)} <span class="mono" style="font-size:11px;color:var(--text-muted)">${escHtml(item.id||'')}</span>
            <span style="flex:1">${escHtml(item.title||'')}</span>
            ${statusBadge(item.status||'open')}
          </div>`).join('')}
      </div></div>
    </div>`);
  }

  const blockedItems = ctx.blockedItems || ctx.blocked || [];
  if (blockedItems.length > 0) {
    sections.push(`<div class="context-section">
      <div class="context-section-title" style="color:var(--status-blocked)">⛔ Blocked (${blockedItems.length})</div>
      <div class="card"><div class="card-body">
        ${blockedItems.map((item: any)=>`
          <div class="context-item-row">
            ${typeIcon(item.type)} <span class="mono" style="font-size:11px;color:var(--text-muted)">${escHtml(item.id||'')}</span>
            <span style="flex:1">${escHtml(item.title||'')}</span>
            ${statusBadge('blocked')}
          </div>`).join('')}
      </div></div>
    </div>`);
  }

  const recentActivity = ctx.recentActivity || ctx.activity || [];
  if (recentActivity.length > 0) {
    sections.push(`<div class="context-section">
      <div class="context-section-title">◎ Recent Activity</div>
      <div class="card"><div class="card-body">
        ${recentActivity.slice(0,10).map((a: any)=>`
          <div class="activity-item">
            <div class="activity-icon">${TYPE_ICONS[a.type]||'◎'}</div>
            <div class="activity-body">
              <div class="activity-desc">${escHtml(a.message||a.title||a.action||'')}</div>
              <div class="activity-time">${relTime(a.timestamp||a.created_at)}</div>
            </div>
          </div>`).join('')}
      </div></div>
    </div>`);
  }

  if (sections.length === 0) {
    sections.push(`<div class="card"><div class="card-body">
      <div class="context-section-title">Raw Context</div>
      <div class="context-block">${escHtml(JSON.stringify(ctx,null,2))}</div>
    </div></div>`);
  }

  return sections.join('');
}
