// ═══════════════════════════════════════════════════════════════
// NORMALIZE VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';

export async function renderNormalizeView(): Promise<void> {
  const el = document.getElementById('content-normalize');
  if (!el) return;
  if (!state.currentProject) { el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>'; return; }
  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Normalize</div><div class="page-subtitle">Lifecycle metadata normalization for ${escHtml(state.currentProject.name)}</div></div>
      <div class="page-actions"><button class="btn btn-secondary btn-sm" onclick="window.__app.renderNormalizeView()">↺ Refresh</button></div>
    </div>
    <div id="normalize-content"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;
  try {
    const data = await api('GET', `/projects/${state.currentProject.id}/pm/normalize`);
    const plan = (data as any).plan || (data as any).normalization || data;
    const items = plan.items || plan.changes || [];
    const el2 = document.getElementById('normalize-content');
    if (!el2) return;
    if (Array.isArray(items) && items.length === 0) {
      el2.innerHTML = `<div class="card"><div class="card-body"><div style="color:var(--status-closed);font-size:13px">✓ All items are normalized — no changes needed!</div></div></div>`;
    } else if (Array.isArray(items) && items.length > 0) {
      el2.innerHTML = `
        <div class="card">
          <div class="card-header"><div class="card-title">Suggested Changes (${items.length})</div></div>
          <div class="card-body">
            ${items.map((i: any) => `
              <div style="display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border)">
                <span style="color:var(--priority-3);flex-shrink:0">⚡</span>
                <div style="flex:1">
                  <div style="font-size:13px">${escHtml(i.message || i.description || JSON.stringify(i))}</div>
                  ${i.id ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px"><a href="#" onclick="window.__app.openItemDetail('${escHtml(i.id)}');return false" style="color:var(--accent)">${escHtml(i.id)}</a></div>` : ''}
                </div>
              </div>`).join('')}
          </div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" onclick="window.__app.applyNormalize()"><span>Apply Normalizations</span></button>
          <span style="font-size:11px;color:var(--text-muted);align-self:center">Dry-run preview — no changes made yet</span>
        </div>`;
    } else {
      el2.innerHTML = `<div class="card"><div class="card-body"><pre style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap">${escHtml(JSON.stringify(plan, null, 2))}</pre></div></div>`;
    }
  } catch(err: unknown) {
    const el2 = document.getElementById('normalize-content');
    if (el2) el2.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

export function applyNormalize(): void {
  if (!state.currentProject) return;
  toast('Normalization applied (dry-run — use CLI with --apply to make changes)', 'info');
}
