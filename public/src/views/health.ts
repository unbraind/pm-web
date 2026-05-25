// ═══════════════════════════════════════════════════════════════
// HEALTH VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';

// Detect item IDs mentioned in a history-drift issue message.
function extractItemIdFromIssue(msg: string): string | null {
  // Common patterns: "history drift for ABC-123", "ABC-123 has history drift", etc.
  const match = msg.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return match ? match[1] : null;
}

function isHistoryDriftIssue(issue: any): boolean {
  const msg: string = (issue.message || issue.description || issue.type || '').toLowerCase();
  return msg.includes('history') && (msg.includes('drift') || msg.includes('repair') || msg.includes('mismatch'));
}

function renderIssueRow(issue: any, projectId: string): string {
  const msg = escHtml(issue.message || issue.description || String(issue));
  if (isHistoryDriftIssue(issue)) {
    const itemId = extractItemIdFromIssue(issue.message || issue.description || '');
    const repairBtn = itemId
      ? `<button class="btn btn-secondary btn-sm" style="margin-left:8px;flex-shrink:0" onclick="window.__app.repairItemHistory('${escHtml(projectId)}','${escHtml(itemId)}',false)">Repair</button>
         <button class="btn btn-ghost btn-sm" style="flex-shrink:0" onclick="window.__app.repairItemHistory('${escHtml(projectId)}','${escHtml(itemId)}',true)" title="Preview without applying">Dry Run</button>`
      : '';
    return `<div class="health-issue-item" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
      <span style="flex:1">⚠ ${msg}</span>${repairBtn}</div>`;
  }
  return `<div class="health-issue-item">⚠ ${msg}</div>`;
}

export async function repairItemHistory(projectId: string, itemId: string, dryRun: boolean): Promise<void> {
  try {
    const data = await api('POST', `/projects/${projectId}/pm/items/${encodeURIComponent(itemId)}/history-repair`, { dryRun });
    if (dryRun) {
      toast(`Dry run for ${itemId}: ${(data as any).message || JSON.stringify(data)}`, 'info');
    } else {
      toast(`History repaired for ${itemId}`, 'success');
    }
  } catch(err: unknown) {
    toast(`Repair failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

export async function renderHealthView(): Promise<void> {
  const el = document.getElementById('content-health');
  if (!el) return;
  if (!state.currentProject) { el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>'; return; }
  const projectId = state.currentProject.id;
  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Project Health</div><div class="page-subtitle">${escHtml(state.currentProject.name)}</div></div>
      <div class="page-actions"><button class="btn btn-secondary btn-sm" onclick="window.__app.renderHealthView()">↺ Refresh</button></div>
    </div>
    <div id="health-content"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;

  try {
    const data = await api('GET',`/projects/${projectId}/pm/health`);
    const health = (data as any).health || data;
    const score = health.score !== undefined ? health.score : null;
    const issues = health.issues || [];

    let scoreColor = '#4ade80';
    if (score !== null) {
      if (score < 50) scoreColor = '#f87171';
      else if (score < 80) scoreColor = '#facc15';
    }

    const contentEl = document.getElementById('health-content');
    if (!contentEl) return;
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
            : issues.map((i: any) => renderIssueRow(i, projectId)).join('')
          }
        </div>
      </div>
      ${health.summary ? `
        <div class="card" style="margin-top:16px">
          <div class="card-header"><div class="card-title">Summary</div></div>
          <div class="card-body"><div class="item-detail-desc">${escHtml(health.summary)}</div></div>
        </div>` : ''}`;
  } catch(err: unknown) {
    const contentEl = document.getElementById('health-content');
    if (contentEl) contentEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}
