// ═══════════════════════════════════════════════════════════════
// VALIDATE VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';

export async function renderValidateView(): Promise<void> {
  const el = document.getElementById('content-validate');
  if (!el) return;
  if (!state.currentProject) { el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>'; return; }
  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Validate</div><div class="page-subtitle">Run metadata & lifecycle validation on ${escHtml(state.currentProject.name)}</div></div>
      <div class="page-actions"><button class="btn btn-secondary btn-sm" onclick="window.__app.renderValidateView()">↺ Refresh</button></div>
    </div>
    <div id="validate-content"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;
  try {
    const data = await api('GET', `/projects/${state.currentProject.id}/pm/validate`) as any;
    const issues = data.issues || data.errors || data.violations || [];
    const warnings = data.warnings || [];
    const el2 = document.getElementById('validate-content');
    if (!el2) return;
    const allIssues = [...issues.map((i: any)=>({...i,level:'error'})), ...warnings.map((w: any)=>({...w,level:'warning'}))];
    el2.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="card-header"><div class="card-title">Validation Results</div></div>
        <div class="card-body">
          ${allIssues.length === 0
            ? '<div style="color:var(--status-closed);font-size:13px">✓ All checks passed — no issues found!</div>'
            : allIssues.map((i: any)=>`
              <div style="display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border)">
                <span style="color:${i.level==='error'?'var(--status-blocked)':'var(--priority-3)'};flex-shrink:0">${i.level==='error'?'✗':'⚠'}</span>
                <div>
                  <div style="font-size:13px">${escHtml(i.message||i.description||JSON.stringify(i))}</div>
                  ${i.id?`<div style="font-size:11px;color:var(--text-muted);margin-top:2px"><a href="#" onclick="window.__app.openItemDetail('${escHtml(i.id)}');return false" style="color:var(--accent)">${escHtml(i.id)}</a></div>`:''}
                </div>
              </div>`).join('')
          }
        </div>
      </div>
      ${data.summary ? `<div class="card"><div class="card-header"><div class="card-title">Summary</div></div><div class="card-body"><div class="item-detail-desc">${escHtml(data.summary)}</div></div></div>` : ''}
      ${data.ok !== undefined ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">Status: <span style="color:${data.ok?'var(--status-closed)':'var(--status-blocked)'}">${data.ok?'PASS':'FAIL'}</span></div>` : ''}`;
  } catch(err: unknown) {
    const el2 = document.getElementById('validate-content');
    if (el2) el2.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}
