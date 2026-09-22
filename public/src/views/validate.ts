// ═══════════════════════════════════════════════════════════════
// VALIDATE VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml, issueRow } from '../utils.js';
import type { ValidateIssue, ValidateResponse } from '../api-types.js';

/** Renders metadata and lifecycle validation results for the current project: a combined list of error and warning issues with item links, an optional summary, and an overall pass/fail status. */
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
    const data = await api<ValidateResponse>('GET', `/projects/${state.currentProject.id}/pm/validate`);
    const issues: ValidateIssue[] = data.issues || data.errors || data.violations || [];
    const warnings: ValidateIssue[] = data.warnings || [];
    const el2 = document.getElementById('validate-content');
    if (!el2) return;
    const allIssues = [...issues.map((i)=>({...i,level:'error'})), ...warnings.map((w)=>({...w,level:'warning'}))];
    el2.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="card-header"><div class="card-title">Validation Results</div></div>
        <div class="card-body">
          ${allIssues.length === 0
            ? '<div style="color:var(--status-closed);font-size:13px">✓ All checks passed — no issues found!</div>'
            : allIssues.map((i)=>issueRow(i.level==='error'?'✗':'⚠', i.level==='error'?'var(--status-blocked)':'var(--priority-3)', i.message||i.description||JSON.stringify(i), i.id, '')).join('')
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
