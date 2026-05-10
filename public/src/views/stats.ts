// ═══════════════════════════════════════════════════════════════
// STATS VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml, statusBadge, typeIcon } from '../utils.js';

export async function renderStatsView(): Promise<void> {
  const el = document.getElementById('content-stats');
  if (!el) return;
  if (!state.currentProject) { el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>'; return; }
  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Stats</div><div class="page-subtitle">${escHtml(state.currentProject.name)} statistics</div></div>
      <div class="page-actions"><button class="btn btn-secondary btn-sm" onclick="window.__app.renderStatsView()">↺ Refresh</button></div>
    </div>
    <div id="stats-content"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;

  try {
    const [statsData, aggData, healthData] = await Promise.all([
      api('GET',`/projects/${state.currentProject.id}/pm/stats`),
      api('GET',`/projects/${state.currentProject.id}/pm/aggregate`).catch(()=>({})),
      api('GET',`/projects/${state.currentProject.id}/pm/health`).catch(()=>({})),
    ]);

    const s = (statsData as any).stats || statsData;
    const health = (healthData as any).health || healthData;
    const byStatus = s.byStatus || {};
    const byType = s.byType || {};
    const total = s.total || (Object.values(byStatus) as number[]).reduce((a,b)=>a+b,0) || 0;
    const openCount = (s.byStatus?.open||0) + (s.byStatus?.in_progress||0);
    const closedCount = s.byStatus?.closed||0;
    const blockedCount = s.byStatus?.blocked||0;
    const maxStatus = Math.max(...(Object.values(byStatus) as number[]),1);
    const maxType = Math.max(...(Object.values(byType) as number[]),1);

    const contentEl = document.getElementById('stats-content');
    if (!contentEl) return;
    contentEl.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Total Items</div></div>
        <div class="stat-card"><div class="stat-value" style="color:var(--status-open)">${openCount}</div><div class="stat-label">Open / In Progress</div></div>
        <div class="stat-card"><div class="stat-value" style="color:var(--status-closed)">${closedCount}</div><div class="stat-label">Closed</div></div>
        <div class="stat-card"><div class="stat-value" style="color:var(--status-blocked)">${blockedCount}</div><div class="stat-label">Blocked</div></div>
        ${total > 0 ? `<div class="stat-card"><div class="stat-value">${Math.round((closedCount/total)*100)}%</div><div class="stat-label">Completion</div></div>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div class="card">
          <div class="card-header"><div class="card-title">By Status</div></div>
          <div class="card-body">
            ${Object.entries(byStatus).sort((a,b)=>(b[1] as number)-(a[1] as number)).map(([k,v])=>`
              <div class="breakdown-row">
                <span class="breakdown-label">${statusBadge(k)}</span>
                <div class="breakdown-bar-wrap"><div class="breakdown-bar" style="width:${Math.round(((v as number)/maxStatus)*100)}%"></div></div>
                <span class="breakdown-count">${v}</span>
              </div>`).join('') || '<div style="color:var(--text-muted);font-size:13px">No data</div>'}
          </div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">By Type</div></div>
          <div class="card-body">
            ${Object.entries(byType).sort((a,b)=>(b[1] as number)-(a[1] as number)).map(([k,v])=>`
              <div class="breakdown-row">
                <span class="breakdown-label">${typeIcon(k)} ${k}</span>
                <div class="breakdown-bar-wrap"><div class="breakdown-bar" style="width:${Math.round(((v as number)/maxType)*100)}%"></div></div>
                <span class="breakdown-count">${v}</span>
              </div>`).join('') || '<div style="color:var(--text-muted);font-size:13px">No data</div>'}
          </div>
        </div>
      </div>
      ${health && ((health as any).issues||(health as any).score!==undefined) ? `
        <div class="card" style="margin-top:16px">
          <div class="card-header">
            <div class="card-title">Project Health</div>
            ${(health as any).score !== undefined ? `<div class="health-indicator">
              <div class="health-dot ${(health as any).score>=80?'health-good':(health as any).score>=50?'health-warn':'health-bad'}"></div>
              <span style="font-size:13px;color:var(--text-secondary)">${(health as any).score}/100</span>
            </div>` : ''}
          </div>
          <div class="card-body">
            ${((health as any).issues||[]).map((i: any)=>`<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;color:var(--text-secondary)">⚠ ${escHtml(i.message||i)}</div>`).join('') || '<div style="color:var(--status-closed);font-size:13px">✓ No issues found</div>'}
          </div>
        </div>` : ''}`;
  } catch(err: unknown) {
    const contentEl = document.getElementById('stats-content');
    if (contentEl) contentEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}
