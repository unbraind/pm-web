// ═══════════════════════════════════════════════════════════════
// COMMENTS AUDIT VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml, statusBadge, typeIcon } from '../utils.js';
export async function renderCommentsAuditView() {
    const el = document.getElementById('content-comments-audit');
    if (!el)
        return;
    if (!state.currentProject) {
        el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>';
        return;
    }
    el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Comments Audit</div>
        <div class="page-subtitle">Review comment coverage across all items in ${escHtml(state.currentProject.name)}</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" onclick="window.__app.renderCommentsAuditView()">↺ Refresh</button>
      </div>
    </div>
    <div id="comments-audit-content"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;
    try {
        const data = await api('GET', `/projects/${state.currentProject.id}/pm/comments-audit`);
        const items = data.items || [];
        const summary = data.summary || {};
        const totals = summary.totals || {};
        const coverage = summary.coverage || {};
        const byType = summary.by_type || [];
        const el2 = document.getElementById('comments-audit-content');
        if (!el2)
            return;
        const coveragePct = Math.round((coverage.items_with_comments_percent || 0));
        el2.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:20px">
        <div class="card"><div class="card-body" style="text-align:center">
          <div style="font-size:28px;font-weight:700;color:var(--accent)">${totals.items_scanned || 0}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Items Scanned</div>
        </div></div>
        <div class="card"><div class="card-body" style="text-align:center">
          <div style="font-size:28px;font-weight:700;color:var(--status-open)">${totals.items_with_comments || 0}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">With Comments</div>
        </div></div>
        <div class="card"><div class="card-body" style="text-align:center">
          <div style="font-size:28px;font-weight:700;color:var(--text-secondary)">${totals.comments_total || 0}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Total Comments</div>
        </div></div>
        <div class="card"><div class="card-body" style="text-align:center">
          <div style="font-size:28px;font-weight:700;color:${coveragePct >= 50 ? 'var(--status-closed)' : 'var(--status-open)'}">${coveragePct}%</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Coverage</div>
        </div></div>
      </div>

      ${byType.length > 0 ? `
        <div class="card" style="margin-bottom:16px">
          <div class="card-header"><div class="card-title">By Type</div></div>
          <div class="card-body" style="padding:0">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead>
                <tr style="border-bottom:1px solid var(--border)">
                  <th style="padding:8px 14px;text-align:left;color:var(--text-muted);font-weight:500">Type</th>
                  <th style="padding:8px 14px;text-align:right;color:var(--text-muted);font-weight:500">Items</th>
                  <th style="padding:8px 14px;text-align:right;color:var(--text-muted);font-weight:500">With Comments</th>
                  <th style="padding:8px 14px;text-align:right;color:var(--text-muted);font-weight:500">Total Comments</th>
                </tr>
              </thead>
              <tbody>
                ${byType.map((row) => `
                  <tr style="border-bottom:1px solid var(--border-subtle)">
                    <td style="padding:8px 14px">${typeIcon(row.type || '')} ${escHtml(row.type || '')}</td>
                    <td style="padding:8px 14px;text-align:right">${row.items_scanned || 0}</td>
                    <td style="padding:8px 14px;text-align:right">${row.items_with_comments || 0}</td>
                    <td style="padding:8px 14px;text-align:right">${row.comments_total || 0}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : ''}

      <div class="card">
        <div class="card-header"><div class="card-title">Items (${items.length})</div></div>
        <div class="card-body" style="padding:0">
          ${items.length === 0
            ? '<div style="padding:20px;color:var(--text-muted);font-size:13px;text-align:center">No items found</div>'
            : `<div class="item-list" style="border-radius:0">
                ${items.map((item) => `
                  <div class="item-row" onclick="window.__app.openItemDetail('${escHtml(item.id)}')">
                    ${typeIcon(item.type || '')}
                    <span class="item-id">${escHtml(item.id)}</span>
                    <span class="item-title">${escHtml(item.title)}</span>
                    <div class="item-meta">
                      ${statusBadge(item.status || 'draft')}
                      <span style="font-size:11px;color:var(--text-muted);background:var(--bg-input);padding:2px 8px;border-radius:10px">${item.comment_count || 0} comment${item.comment_count !== 1 ? 's' : ''}</span>
                    </div>
                  </div>`).join('')}
              </div>`}
        </div>
      </div>`;
    }
    catch (err) {
        const el2 = document.getElementById('comments-audit-content');
        if (el2)
            el2.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
    }
}
//# sourceMappingURL=comments-audit.js.map