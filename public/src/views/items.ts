// ═══════════════════════════════════════════════════════════════
// ITEMS VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml, statusBadge, priorityDot, typeIcon } from '../utils.js';
import { showModal, hideModal, createModal, confirmDialog } from '../components/modals.js';
import { toast } from '../components/toast.js';
import { TYPES, STATUSES, TYPE_ICONS, PRIORITY_LABELS } from '../constants.js';
import { showView } from './router.js';
import { loadItemsBadge } from './projects.js';
import type { Item } from '../types.js';

export async function renderItemsView(): Promise<void> {
  const el = document.getElementById('content-items');
  if (!el) return;
  if (!state.currentProject) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>';
    return;
  }

  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Items</div>
        <div class="page-subtitle" id="items-subtitle">Loading…</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" onclick="window.__app.renderItemsView()" title="Refresh">↺ Refresh</button>
        <button class="btn btn-primary" onclick="window.__app.showView('create')">+ New Item</button>
      </div>
    </div>
    <div class="status-tabs" style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
      ${['','open','in_progress','blocked','draft','closed','canceled'].map(s=>`<button class="btn btn-sm ${state.itemFilters.status===s?'btn-primary':'btn-ghost'}" onclick="window.__app.setStatusFilter('${s}')">${s===''?'All':s.replace('_',' ')}</button>`).join('')}
    </div>
    <div class="filter-bar">
      <select class="filter-select" id="filter-status" onchange="window.__app.applyItemFilters()">
        <option value="">All Statuses</option>
        ${STATUSES.map(s=>`<option value="${s}"${state.itemFilters.status===s?' selected':''}>${s.replace('_',' ')}</option>`).join('')}
      </select>
      <select class="filter-select" id="filter-type" onchange="window.__app.applyItemFilters()">
        <option value="">All Types</option>
        ${TYPES.map(t=>`<option value="${t}"${state.itemFilters.type===t?' selected':''}>${t}</option>`).join('')}
      </select>
      <select class="filter-select" id="filter-priority" onchange="window.__app.applyItemFilters()">
        <option value="">All Priorities</option>
        ${[1,2,3,4,5].map(p=>`<option value="${p}"${state.itemFilters.priority==String(p)?' selected':''}>P${p}: ${PRIORITY_LABELS[p]}</option>`).join('')}
      </select>
      <input class="filter-select" id="filter-sprint" type="text" placeholder="Sprint…" value="${escHtml(state.itemFilters.sprint)}" oninput="window.__app.applyItemFilters()" style="width:100px">
      <input class="filter-select" id="filter-release" type="text" placeholder="Release…" value="${escHtml(state.itemFilters.release)}" oninput="window.__app.applyItemFilters()" style="width:100px">
      <input class="filter-select" id="filter-assignee" type="text" placeholder="Assignee…" value="${escHtml(state.itemFilters.assignee)}" oninput="window.__app.applyItemFilters()" style="width:110px">
      <button class="btn btn-ghost btn-sm" onclick="window.__app.clearFilters()">Clear</button>
    </div>
    <div id="items-list"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;

  await fetchAndRenderItems();
}

export async function fetchAndRenderItems(): Promise<void> {
  const pid = state.currentProject?.id;
  if (!pid) return;
  const f = state.itemFilters;
  let params = 'limit=200';
  if (f.status) params += `&status=${encodeURIComponent(f.status)}`;
  if (f.type) params += `&type=${encodeURIComponent(f.type)}`;
  if (f.priority) params += `&priority=${encodeURIComponent(f.priority)}`;
  if (f.sprint) params += `&sprint=${encodeURIComponent(f.sprint)}`;
  if (f.release) params += `&release=${encodeURIComponent(f.release)}`;
  if (f.assignee) params += `&assignee=${encodeURIComponent(f.assignee)}`;

  const endpoint = f.status ? `list?${params}` : `list-all?${params}`;

  try {
    const data = await api('GET',`/projects/${pid}/pm/${endpoint}`);
    state.items = data.items || [];
    const sub = document.getElementById('items-subtitle');
    if (sub) sub.textContent = `${state.items.length} item${state.items.length!==1?'s':''}`;
    renderItemsList();
  } catch(err: unknown) {
    const listEl = document.getElementById('items-list');
    if (listEl) listEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Failed to load items: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

function renderItemsList(): void {
  const el = document.getElementById('items-list');
  if (!el) return;
  if (state.items.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">📋</div>
      <div class="empty-state-text">No items found</div>
      <div class="empty-state-sub">Try adjusting filters or <a href="#" onclick="window.__app.showView('create');return false" style="color:var(--accent)">create a new item</a></div>
    </div>`;
    return;
  }
  el.innerHTML = `<div class="item-list">${state.items.map(item => renderItemRow(item)).join('')}</div>`;
}

export function renderItemRow(item: Item): string {
  const tags = (item.tags||[]).map(t=>`<span class="tag">${escHtml(t)}</span>`).join('');
  return `<div class="item-row" onclick="window.__app.openItemDetail('${escHtml(item.id)}')">
    ${typeIcon(item.type||'')}
    <span class="item-id">${escHtml(item.id)}</span>
    <span class="item-title">${escHtml(item.title)}</span>
    <div class="item-meta">
      ${tags ? `<div class="item-tags">${tags}</div>` : ''}
      ${priorityDot(item.priority||5)}
      ${statusBadge(item.status||'draft')}
    </div>
  </div>`;
}

export function applyItemFilters(): void {
  const fs = document.getElementById('filter-status') as HTMLSelectElement | null;
  const ft = document.getElementById('filter-type') as HTMLSelectElement | null;
  const fp = document.getElementById('filter-priority') as HTMLSelectElement | null;
  const fsp = document.getElementById('filter-sprint') as HTMLInputElement | null;
  const frl = document.getElementById('filter-release') as HTMLInputElement | null;
  const fas = document.getElementById('filter-assignee') as HTMLInputElement | null;
  state.itemFilters.status = fs?.value || '';
  state.itemFilters.type = ft?.value || '';
  state.itemFilters.priority = fp?.value || '';
  state.itemFilters.sprint = fsp?.value || '';
  state.itemFilters.release = frl?.value || '';
  state.itemFilters.assignee = fas?.value || '';
  fetchAndRenderItems();
}

export function clearFilters(): void {
  state.itemFilters = { status:'', type:'', priority:'', sprint:'', release:'', assignee:'' };
  const ids = ['filter-status','filter-type','filter-priority','filter-sprint','filter-release','filter-assignee'];
  ids.forEach(id => {
    const el = document.getElementById(id) as (HTMLInputElement | HTMLSelectElement) | null;
    if (el) el.value = '';
  });
  fetchAndRenderItems();
}

export function setStatusFilter(status: string): void {
  state.itemFilters.status = status;
  renderItemsView();
}

// ═══════════════════════════════════════════════════════════════
// ITEM DETAIL MODAL
// ═══════════════════════════════════════════════════════════════
export async function openItemDetail(itemId: string): Promise<void> {
  const pid = state.currentProject?.id;
  if (!pid) return;

  createModal('item-detail-modal', 'Loading…', '<div class="loading-state"><div class="loading-spinner"></div></div>', '', true);
  showModal('item-detail-modal');

  try {
    const [itemData, commentsData, historyData, depsData, learningsData, notesData, testsData, filesData] = await Promise.all([
      api('GET',`/projects/${pid}/pm/get/${itemId}`),
      api('GET',`/projects/${pid}/pm/comments/${itemId}`).catch(()=>({comments:[]})),
      api('GET',`/projects/${pid}/pm/history/${itemId}`).catch(()=>({history:[]})),
      api('GET',`/projects/${pid}/pm/deps/${itemId}`).catch(()=>({deps:[]})),
      api('GET',`/projects/${pid}/pm/learnings/${itemId}`).catch(()=>({learnings:[]})),
      api('GET',`/projects/${pid}/pm/notes/${itemId}`).catch(()=>({notes:[]})),
      api('GET',`/projects/${pid}/pm/tests/${itemId}`).catch(()=>({tests:[]})),
      api('GET',`/projects/${pid}/pm/files/${itemId}`).catch(()=>({files:[]})),
    ]);

    const item = itemData.item || itemData;
    const comments = commentsData.comments || [];
    const history = historyData.history || [];
    const deps = depsData.deps || depsData.dependencies || [];
    const learnings = learningsData.learnings || [];
    const notes = notesData.notes || [];
    const tests = testsData.tests || [];
    const files = filesData.files || [];

    const modal = document.getElementById('item-detail-modal');
    if (modal) {
      const titleEl = modal.querySelector('.modal-title');
      if (titleEl) titleEl.textContent = item.id;
    }

    const tags = (item.tags||[]).map((t: string)=>`<span class="tag">${escHtml(t)}</span>`).join('');

    const notesHtml = notes.length === 0
      ? '<div style="color:var(--text-muted);font-size:13px;margin-bottom:12px">No notes yet</div>'
      : notes.map((n: any)=>`
          <div class="notes-item">
            <div class="notes-item-meta">${relTime(n.timestamp||n.created_at||'')}</div>
            <div class="notes-item-text">${escHtml(n.text||n.content||JSON.stringify(n))}</div>
          </div>`).join('');

    const testsHtml = tests.length === 0
      ? '<div style="color:var(--text-muted);font-size:13px;margin-bottom:12px">No tests defined</div>'
      : tests.map((t: any)=>`
          <div class="test-item">
            <div style="flex:1">
              <div class="test-item-cmd">${escHtml(t.command||t.cmd||JSON.stringify(t))}</div>
              ${t.description ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:3px">${escHtml(t.description)}</div>` : ''}
            </div>
          </div>`).join('');

    const commentsHtml = comments.length === 0
      ? '<div style="color:var(--text-muted);font-size:13px">No comments yet</div>'
      : comments.map((c: any)=>`
          <div class="comment-item">
            <div class="comment-avatar">💬</div>
            <div class="comment-body">
              <div class="comment-meta">${fmtDate(c.timestamp||c.created_at)}</div>
              <div class="comment-text">${escHtml(c.text||c.content||c.body||JSON.stringify(c))}</div>
            </div>
          </div>`).join('');

    const historyHtml = history.length === 0
      ? '<div style="color:var(--text-muted);font-size:13px">No history</div>'
      : history.slice(0,10).map((h: any)=>`
          <div class="history-item">
            <div class="history-dot"></div>
            <div><div class="history-text">${escHtml(h.message||h.action||JSON.stringify(h))}</div><div class="history-time">${relTime(h.timestamp||h.created_at)}</div></div>
          </div>`).join('');

    const bodyEl = modal?.querySelector('.modal-body');
    if (bodyEl) {
      bodyEl.innerHTML = `
      <div class="item-detail-header">
        <div class="item-detail-id">${typeIcon(item.type||'')} ${escHtml(item.type)} · ${escHtml(item.id)}</div>
        <div class="item-detail-title">${escHtml(item.title)}</div>
        <div class="item-detail-meta">
          ${statusBadge(item.status||'draft')}
          <div class="meta-chip">${priorityDot(item.priority||5)} <strong>P${item.priority}</strong> ${PRIORITY_LABELS[item.priority]||''}</div>
          ${item.created_at ? `<div class="meta-chip">Created <strong>${fmtDate(item.created_at)}</strong></div>` : ''}
          ${item.updated_at ? `<div class="meta-chip">Updated <strong>${relTime(item.updated_at)}</strong></div>` : ''}
          ${item.parent ? `<div class="meta-chip">Parent <strong class="mono">${escHtml(item.parent)}</strong></div>` : ''}
          ${item.claimedBy ? `<div class="meta-chip">Claimed by <strong>${escHtml(item.claimedBy)}</strong></div>` : ''}
          ${item.deadline ? `<div class="meta-chip">Due <strong>${fmtDate(item.deadline)}</strong></div>` : ''}
          ${item.assignee ? `<div class="meta-chip">Assignee <strong>${escHtml(item.assignee)}</strong></div>` : ''}
          ${item.sprint ? `<div class="meta-chip">Sprint <strong>${escHtml(item.sprint)}</strong></div>` : ''}
          ${item.release ? `<div class="meta-chip">Release <strong>${escHtml(item.release)}</strong></div>` : ''}
          ${item.estimated_minutes ? `<div class="meta-chip">~${item.estimated_minutes}m</div>` : ''}
          ${tags ? `<div class="item-tags">${tags}</div>` : ''}
        </div>
        <div class="claim-btn-wrap">
          <button class="btn btn-secondary btn-sm" onclick="window.__app.claimItem('${escHtml(itemId)}')">⊕ Claim</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__app.releaseItem('${escHtml(itemId)}')">⊖ Release</button>
          ${item.status === 'open' ? `<button class="btn btn-secondary btn-sm" onclick="window.__app.startItem('${escHtml(itemId)}')">▶ Start</button>` : ''}
          ${item.status === 'in_progress' ? `<button class="btn btn-ghost btn-sm" onclick="window.__app.pauseItem('${escHtml(itemId)}')">⏸ Pause</button>` : ''}
        </div>
      </div>

      ${item.description ? `
        <div class="item-detail-section">
          <div class="item-detail-section-title">Description</div>
          <div class="item-detail-desc">${escHtml(item.description)}</div>
        </div>` : ''}

      <div class="tabs">
        <div class="tab active" onclick="window.__app.switchDetailTab(this,'tab-comments')">Comments (${comments.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-update')">Update</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-notes')">Notes (${notes.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-deps')">Deps (${deps.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-learnings')">Learnings (${learnings.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-tests')">Tests (${tests.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-files')">Files (${files.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-history')">History</div>
        ${item.status!=='closed'&&item.status!=='canceled'?`<div class="tab" onclick="window.__app.switchDetailTab(this,'tab-close')">Close</div>`:''}
      </div>

      <div id="tab-comments">
        ${commentsHtml}
        <hr class="section-divider">
        <div class="form-group">
          <label class="form-label">Add Comment</label>
          <textarea class="form-textarea" id="new-comment" placeholder="Write a comment…" rows="3"></textarea>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__app.addComment('${escHtml(itemId)}')">Post Comment</button>
      </div>

      <div id="tab-update" style="display:none">
        <div class="form-group">
          <label class="form-label">Title</label>
          <input class="form-input" id="edit-title" type="text" value="${escHtml(item.title)}">
        </div>
        <div class="two-col">
          <div class="form-group">
            <label class="form-label">Status</label>
            <select class="form-select" id="edit-status">
              ${STATUSES.map(s=>`<option value="${s}"${item.status===s?' selected':''}>${s.replace('_',' ')}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Priority</label>
            <select class="form-select" id="edit-priority">
              ${[1,2,3,4,5].map(p=>`<option value="${p}"${item.priority==p?' selected':''}>P${p}: ${PRIORITY_LABELS[p]}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Tags (comma-separated)</label>
          <input class="form-input" id="edit-tags" type="text" value="${escHtml((item.tags||[]).join(', '))}">
        </div>
        <div class="two-col">
          <div class="form-group">
            <label class="form-label">Deadline</label>
            <input class="form-input" id="edit-deadline" type="text" placeholder="+1d, +1w, 2026-06-01" value="${escHtml(item.deadline||'')}">
          </div>
          <div class="form-group">
            <label class="form-label">Assignee</label>
            <input class="form-input" id="edit-assignee" type="text" value="${escHtml(item.assignee||'')}">
          </div>
        </div>
        <div class="two-col">
          <div class="form-group">
            <label class="form-label">Sprint</label>
            <input class="form-input" id="edit-sprint" type="text" value="${escHtml(item.sprint||'')}">
          </div>
          <div class="form-group">
            <label class="form-label">Release</label>
            <input class="form-input" id="edit-release" type="text" value="${escHtml(item.release||'')}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Estimated Minutes</label>
          <input class="form-input" id="edit-estimate" type="number" min="1" value="${escHtml(String(item.estimated_minutes||''))}">
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <textarea class="form-textarea" id="edit-desc" rows="4">${escHtml(item.description||'')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Body (extended)</label>
          <textarea class="form-textarea" id="edit-body" rows="3">${escHtml(item.body||'')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Acceptance Criteria</label>
          <textarea class="form-textarea" id="edit-acceptance-criteria" rows="2">${escHtml(item.acceptance_criteria||item.acceptanceCriteria||'')}</textarea>
        </div>
        <button class="btn btn-primary" onclick="window.__app.updateItem('${escHtml(itemId)}')">Save Changes</button>
      </div>

      <div id="tab-notes" style="display:none">
        <div style="margin-bottom:16px">${notesHtml}</div>
        <hr class="section-divider">
        <div class="form-group">
          <label class="form-label">Add Note</label>
          <textarea class="form-textarea" id="new-note" placeholder="Add a note to this item…" rows="4"></textarea>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__app.addNote('${escHtml(itemId)}')">Add Note</button>
        <hr class="section-divider">
        <div class="form-group">
          <label class="form-label">Append to Description</label>
          <textarea class="form-textarea" id="new-append" placeholder="Text to append…" rows="3"></textarea>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="window.__app.appendItem('${escHtml(itemId)}')">Append</button>
      </div>

      <div id="tab-deps" style="display:none">
        <div style="margin-bottom:16px">
          ${deps.length === 0
            ? `<div style="color:var(--text-muted);font-size:13px;margin-bottom:12px">No dependencies</div>`
            : deps.map((d: any)=>`<div class="dep-row">
                <span class="dep-rel">${escHtml(d.rel||d.relationship||'deps')}</span>
                <span class="dep-id" onclick="window.__app.hideModal('item-detail-modal');window.__app.openItemDetail('${escHtml(d.targetId||d.id||'')}')">
                  ${escHtml(d.targetId||d.id||'')}
                </span>
                <span style="flex:1;color:var(--text-secondary);font-size:12px">${escHtml(d.targetTitle||d.title||'')}</span>
              </div>`).join('')
          }
        </div>
        <hr class="section-divider">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Add Dependency</div>
        <div class="row" style="margin-bottom:8px">
          <input class="form-input flex-1" id="dep-target-id" type="text" placeholder="Item ID (e.g. ${escHtml(state.currentProject?.prefix||'proj')}-5)">
          <select class="form-select" id="dep-rel" style="width:140px">
            <option value="depends_on">depends on</option>
            <option value="blocks">blocks</option>
            <option value="related_to">related to</option>
            <option value="duplicates">duplicates</option>
          </select>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__app.addDep('${escHtml(itemId)}')">Add Dependency</button>
      </div>

      <div id="tab-learnings" style="display:none">
        <div style="margin-bottom:16px">
          ${learnings.length === 0
            ? `<div style="color:var(--text-muted);font-size:13px;margin-bottom:12px">No learnings recorded</div>`
            : learnings.map((l: any)=>`<div class="learning-row">
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">${relTime(l.timestamp||l.created_at||'')}</div>
                ${escHtml(l.text||l.content||JSON.stringify(l))}
              </div>`).join('')
          }
        </div>
        <hr class="section-divider">
        <div class="form-group">
          <label class="form-label">Add Learning</label>
          <textarea class="form-textarea" id="new-learning" placeholder="What did you learn working on this item?" rows="3"></textarea>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__app.addLearning('${escHtml(itemId)}')">Record Learning</button>
      </div>

      <div id="tab-tests" style="display:none">
        <div style="margin-bottom:16px">${testsHtml}</div>
        <hr class="section-divider">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Add Test</div>
        <div class="form-group">
          <label class="form-label">Command *</label>
          <input class="form-input" id="new-test-cmd" type="text" placeholder="npm test, pytest tests/, etc.">
        </div>
        <div class="form-group">
          <label class="form-label">Description (optional)</label>
          <input class="form-input" id="new-test-desc" type="text" placeholder="What does this test verify?">
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__app.addTest('${escHtml(itemId)}')">Add Test</button>
      </div>

      <div id="tab-history" style="display:none">${historyHtml}</div>

      <div id="tab-files" style="display:none">
        <div style="margin-bottom:16px">
          ${files.length === 0
            ? '<div style="color:var(--text-muted);font-size:13px;margin-bottom:12px">No files linked</div>'
            : files.map((f: any) => `
                <div class="file-row">
                  <span style="color:var(--text-muted)">📄</span>
                  <span class="file-path">${escHtml(f.path || f.name || JSON.stringify(f))}</span>
                  ${f.scope ? `<span style="font-size:10px;color:var(--text-muted);background:var(--bg-input);padding:2px 6px;border-radius:4px">${escHtml(f.scope)}</span>` : ''}
                </div>`).join('')
          }
        </div>
        <hr class="section-divider">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Link File</div>
        <div class="row" style="margin-bottom:8px">
          <input class="form-input flex-1" id="file-path-input" type="text" placeholder="src/components/App.tsx">
          <button class="btn btn-primary btn-sm" onclick="window.__app.addFileLink('${escHtml(itemId)}')">Add</button>
        </div>
      </div>

      ${item.status!=='closed'&&item.status!=='canceled'?`
      <div id="tab-close" style="display:none">
        <div class="form-group">
          <label class="form-label">Close Reason *</label>
          <textarea class="form-textarea" id="close-reason" placeholder="Why is this being closed?" rows="3"></textarea>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="window.__app.closeItem('${escHtml(itemId)}','closed')">Mark Closed</button>
          <button class="btn btn-secondary" onclick="window.__app.closeItem('${escHtml(itemId)}','canceled')">Mark Canceled</button>
          <button class="btn btn-danger btn-sm" onclick="window.__app.confirmDeleteItem('${escHtml(itemId)}')">Delete Item</button>
        </div>
      </div>`:''}
    `;
    }
  } catch(err: unknown) {
    const bodyEl = document.getElementById('item-detail-modal')?.querySelector('.modal-body');
    if (bodyEl) bodyEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Failed to load: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

function relTime(ts: string | undefined | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff/1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  if (s < 604800) return `${Math.floor(s/86400)}d ago`;
  return d.toLocaleDateString();
}

function fmtDate(ts: string | undefined | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
}

export function switchDetailTab(tabEl: HTMLElement, targetId: string): void {
  const allTabs = tabEl.parentElement?.querySelectorAll('.tab');
  allTabs?.forEach(t => t.classList.remove('active'));
  tabEl.classList.add('active');
  const ids = ['tab-comments','tab-update','tab-notes','tab-deps','tab-learnings','tab-tests','tab-files','tab-history','tab-close'];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = id===targetId?'':'none'; });
}

export async function addComment(itemId: string): Promise<void> {
  const el = document.getElementById('new-comment') as HTMLTextAreaElement | null;
  if (!el) return;
  const text = el.value.trim();
  if (!text) { toast('Comment cannot be empty','error'); return; }
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/comments/${itemId}`,{text});
    toast('Comment added','success');
    el.value = '';
    openItemDetail(itemId);
  } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
}

export async function addNote(itemId: string): Promise<void> {
  const el = document.getElementById('new-note') as HTMLTextAreaElement | null;
  if (!el) return;
  const text = el.value.trim();
  if (!text) { toast('Note cannot be empty','error'); return; }
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/notes/${itemId}`,{text});
    toast('Note added','success');
    el.value = '';
  } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
}

export async function appendItem(itemId: string): Promise<void> {
  const el = document.getElementById('new-append') as HTMLTextAreaElement | null;
  if (!el) return;
  const text = el.value.trim();
  if (!text) { toast('Text cannot be empty','error'); return; }
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/append/${itemId}`,{text});
    toast('Appended','success');
    el.value = '';
  } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
}

export async function updateItem(itemId: string): Promise<void> {
  const titleEl = document.getElementById('edit-title') as HTMLInputElement | null;
  const statusEl = document.getElementById('edit-status') as HTMLSelectElement | null;
  const priorityEl = document.getElementById('edit-priority') as HTMLSelectElement | null;
  const tagsEl = document.getElementById('edit-tags') as HTMLInputElement | null;
  const descEl = document.getElementById('edit-desc') as HTMLTextAreaElement | null;
  const deadlineEl = document.getElementById('edit-deadline') as HTMLInputElement | null;
  const assigneeEl = document.getElementById('edit-assignee') as HTMLInputElement | null;
  const sprintEl = document.getElementById('edit-sprint') as HTMLInputElement | null;
  const releaseEl = document.getElementById('edit-release') as HTMLInputElement | null;
  const estimateEl = document.getElementById('edit-estimate') as HTMLInputElement | null;
  const bodyEl = document.getElementById('edit-body') as HTMLTextAreaElement | null;
  const acEl = document.getElementById('edit-acceptance-criteria') as HTMLTextAreaElement | null;

  const title = titleEl?.value.trim() || '';
  const status = statusEl?.value || '';
  const priority = priorityEl?.value || '';
  const tags = tagsEl?.value.trim() || '';
  const description = descEl?.value.trim() || '';
  const deadline = deadlineEl?.value.trim() || '';
  const assignee = assigneeEl?.value.trim() || '';
  const sprint = sprintEl?.value.trim() || '';
  const release = releaseEl?.value.trim() || '';
  const estimate = estimateEl?.value.trim() || '';
  const body = bodyEl?.value.trim() || '';
  const acceptanceCriteria = acEl?.value.trim() || '';

  if (!title) { toast('Title required','error'); return; }
  try {
    const payload: Record<string, string> = {title,status,priority,tags,description};
    if (deadline) payload.deadline = deadline;
    if (assignee) payload.assignee = assignee;
    if (sprint) payload.sprint = sprint;
    if (release) payload.release = release;
    if (estimate) payload.estimate = estimate;
    if (body) payload.body = body;
    if (acceptanceCriteria) payload.acceptanceCriteria = acceptanceCriteria;
    await api('PATCH',`/projects/${state.currentProject!.id}/pm/update/${itemId}`,payload);
    toast('Item updated','success');
    openItemDetail(itemId);
    if (state.currentView==='items') fetchAndRenderItems();
    loadItemsBadge();
  } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
}

export async function closeItem(itemId: string, targetStatus: string): Promise<void> {
  const reasonEl = document.getElementById('close-reason') as HTMLTextAreaElement | null;
  const reason = reasonEl?.value?.trim();
  if (!reason) { toast('Close reason is required','error'); return; }
  try {
    if (targetStatus === 'canceled') {
      await api('PATCH',`/projects/${state.currentProject!.id}/pm/update/${itemId}`,{status:'canceled'});
      await api('POST',`/projects/${state.currentProject!.id}/pm/close/${itemId}`,{reason});
    } else {
      await api('POST',`/projects/${state.currentProject!.id}/pm/close/${itemId}`,{reason});
    }
    toast(`Item ${targetStatus}`,'success');
    hideModal('item-detail-modal');
    if (state.currentView==='items') fetchAndRenderItems();
    loadItemsBadge();
  } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
}

export function confirmDeleteItem(itemId: string): void {
  confirmDialog('Delete Item?', 'This action cannot be undone. The item and all its data will be permanently removed.', async () => {
    try {
      await api('DELETE',`/projects/${state.currentProject!.id}/pm/delete/${itemId}`);
      toast('Item deleted','success');
      hideModal('item-detail-modal');
      if (state.currentView==='items') fetchAndRenderItems();
      loadItemsBadge();
    } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
  }, true);
}

// ═══════════════════════════════════════════════════════════════
// CLAIM / RELEASE / START / PAUSE
// ═══════════════════════════════════════════════════════════════
export async function claimItem(itemId: string): Promise<void> {
  const row = document.querySelector(`.item-row[onclick*="${itemId}"]`) as HTMLElement | null;
  if (row) row.style.opacity = '0.6';
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/claim/${itemId}`,{});
    toast('Item claimed','success');
    openItemDetail(itemId);
    if (state.currentView==='items') fetchAndRenderItems();
  } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); if (row) row.style.opacity = ''; }
}

export async function releaseItem(itemId: string): Promise<void> {
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/release/${itemId}`,{});
    toast('Item released','success');
    openItemDetail(itemId);
    if (state.currentView==='items') fetchAndRenderItems();
  } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
}

export async function startItem(itemId: string): Promise<void> {
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/start-task/${itemId}`,{});
    toast('Item started','success');
    openItemDetail(itemId);
    if (state.currentView==='items') fetchAndRenderItems();
    loadItemsBadge();
  } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
}

export async function pauseItem(itemId: string): Promise<void> {
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/pause-task/${itemId}`,{});
    toast('Item paused','success');
    openItemDetail(itemId);
    if (state.currentView==='items') fetchAndRenderItems();
    loadItemsBadge();
  } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
}

// ═══════════════════════════════════════════════════════════════
// DEPS / LEARNINGS / TESTS / FILES
// ═══════════════════════════════════════════════════════════════
export async function addDep(itemId: string): Promise<void> {
  const targetIdEl = document.getElementById('dep-target-id') as HTMLInputElement | null;
  const relEl = document.getElementById('dep-rel') as HTMLSelectElement | null;
  const targetId = targetIdEl?.value?.trim() || '';
  const rel = relEl?.value || 'depends_on';
  if (!targetId) { toast('Target item ID is required','error'); return; }
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/deps/${itemId}`,{targetId,rel});
    toast('Dependency added','success');
    openItemDetail(itemId);
  } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
}

export async function addLearning(itemId: string): Promise<void> {
  const el = document.getElementById('new-learning') as HTMLTextAreaElement | null;
  const text = el?.value?.trim() || '';
  if (!text) { toast('Learning text is required','error'); return; }
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/learnings/${itemId}`,{text});
    toast('Learning recorded','success');
    openItemDetail(itemId);
  } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
}

export async function addTest(itemId: string): Promise<void> {
  const cmdEl = document.getElementById('new-test-cmd') as HTMLInputElement | null;
  const descEl = document.getElementById('new-test-desc') as HTMLInputElement | null;
  const command = cmdEl?.value?.trim() || '';
  const description = descEl?.value?.trim() || '';
  if (!command) { toast('Test command is required','error'); return; }
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/tests/${itemId}`,{command,description});
    toast('Test added','success');
    openItemDetail(itemId);
  } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
}

export async function addFileLink(itemId: string): Promise<void> {
  const el = document.getElementById('file-path-input') as HTMLInputElement | null;
  const filePath = el?.value?.trim() || '';
  if (!filePath) { toast('File path is required','error'); return; }
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/files/${itemId}`,{path:filePath});
    toast('File linked','success');
    openItemDetail(itemId);
  } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
}
