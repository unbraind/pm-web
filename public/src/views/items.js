// ═══════════════════════════════════════════════════════════════
// ITEMS VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml, statusBadge, priorityDot, typeIcon } from '../utils.js';
import { showModal, hideModal, createModal, confirmDialog } from '../components/modals.js';
import { toast } from '../components/toast.js';
import { getTypes, getStatuses, PRIORITY_LABELS } from '../constants.js';
import { showView } from './router.js';
import { loadItemsBadge } from './projects.js';
import { renderLocalGraph, destroyLocalGraph } from './graph.js';
const DEP_REL_OPTIONS = [
    { value: 'blocked_by', label: 'Blocked by / depends on' },
    { value: 'blocks', label: 'Blocks' },
    { value: 'parent', label: 'Parent' },
    { value: 'child', label: 'Child' },
    { value: 'related', label: 'Related' },
];
function normalizeDepRelation(raw) {
    const aliases = {
        blockedby: 'blocked_by',
        blocked_by: 'blocked_by',
        blockedbyid: 'blocked_by',
        depends_on: 'blocked_by',
        dependson: 'blocked_by',
        dependency: 'blocked_by',
        depends: 'blocked_by',
        blocked: 'blocked_by',
        parent_of: 'parent',
        child_of: 'child',
        relates_to: 'related',
        related_to: 'related',
        related: 'related',
        blocks: 'blocks',
    };
    const normalized = (raw || '').trim().toLowerCase().replace(/-/g, '_');
    return aliases[normalized] ?? normalized;
}
function renderDependencyOptions(selected) {
    const current = normalizeDepRelation(selected);
    return DEP_REL_OPTIONS
        .map((option) => `<option value="${option.value}"${option.value === current ? ' selected' : ''}>${option.label}</option>`)
        .join('');
}
function depLabel(rel) {
    const labels = {
        blocked_by: 'Blocked by',
        blocks: 'Blocks',
        parent: 'Parent',
        child: 'Child',
        related: 'Related',
    };
    return labels[normalizeDepRelation(rel)] || rel;
}
function depTargetId(dep) {
    return String(dep.targetId || dep.id || dep.target || '').trim();
}
function depRelation(dep) {
    return normalizeDepRelation(String(dep.rel || dep.relationship || dep.type || dep.kind || 'blocked_by'));
}
// ═══════════════════════════════════════════════════════════════
// BULK UPDATE
// ═══════════════════════════════════════════════════════════════
export function showBulkUpdateModal() {
    if (!state.currentProject) {
        toast('Select a project first', 'info');
        return;
    }
    createModal('bulk-update-modal', 'Bulk Update Items', `
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Filter Items</div>
      <div class="two-col">
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="bu-filter-status">
            <option value="">Any status</option>
            ${getStatuses(state.schema).map(s => `<option value="${s}">${s.replace('_', ' ')}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Type</label>
          <select class="form-select" id="bu-filter-type">
            <option value="">Any type</option>
            ${getTypes(state.schema).map(t => `<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="two-col">
        <div class="form-group">
          <label class="form-label">Sprint</label>
          <input class="form-input" id="bu-filter-sprint" type="text" placeholder="Filter by sprint…">
        </div>
        <div class="form-group">
          <label class="form-label">Assignee</label>
          <input class="form-input" id="bu-filter-assignee" type="text" placeholder="Filter by assignee…">
        </div>
      </div>
    </div>
    <hr class="section-divider">
    <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Fields to Update</div>
    <div class="two-col">
      <div class="form-group">
        <label class="form-label">Set Priority</label>
        <select class="form-select" id="bu-set-priority">
          <option value="">— don't change —</option>
          ${[0, 1, 2, 3, 4].map(p => `<option value="${p}">P${p}: ${PRIORITY_LABELS[p]}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Set Status</label>
        <select class="form-select" id="bu-set-status">
          <option value="">— don't change —</option>
          ${getStatuses(state.schema).map(s => `<option value="${s}">${s.replace('_', ' ')}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="two-col">
      <div class="form-group">
        <label class="form-label">Set Sprint</label>
        <input class="form-input" id="bu-set-sprint" type="text" placeholder="New sprint value…">
      </div>
      <div class="form-group">
        <label class="form-label">Set Release</label>
        <input class="form-input" id="bu-set-release" type="text" placeholder="New release value…">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Set Assignee</label>
      <input class="form-input" id="bu-set-assignee" type="text" placeholder="New assignee…">
    </div>
    <div id="bu-preview" style="margin-top:12px"></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-secondary" onclick="window.__app.previewBulkUpdate()">Preview</button>
      <button class="btn btn-primary" id="bu-apply-btn" onclick="window.__app.applyBulkUpdate()" disabled>Apply Update</button>
    </div>`, '');
    showModal('bulk-update-modal');
}
export async function previewBulkUpdate() {
    const pid = state.currentProject?.id;
    if (!pid)
        return;
    const previewEl = document.getElementById('bu-preview');
    if (previewEl)
        previewEl.innerHTML = '<div class="loading-state" style="padding:12px 0"><div class="loading-spinner"></div></div>';
    const fStatus = document.getElementById('bu-filter-status')?.value || '';
    const fType = document.getElementById('bu-filter-type')?.value || '';
    const fSprint = document.getElementById('bu-filter-sprint')?.value.trim() || '';
    const fAssignee = document.getElementById('bu-filter-assignee')?.value.trim() || '';
    const uPriority = document.getElementById('bu-set-priority')?.value || '';
    const uStatus = document.getElementById('bu-set-status')?.value || '';
    const uSprint = document.getElementById('bu-set-sprint')?.value.trim() || '';
    const uRelease = document.getElementById('bu-set-release')?.value.trim() || '';
    const uAssignee = document.getElementById('bu-set-assignee')?.value.trim() || '';
    const hasUpdate = uPriority || uStatus || uSprint || uRelease || uAssignee;
    if (!hasUpdate) {
        if (previewEl)
            previewEl.innerHTML = '<div style="color:var(--status-open);font-size:13px">Select at least one field to update.</div>';
        return;
    }
    // Build payload matching the backend's flat field format
    const payload = {};
    if (fStatus)
        payload.filterStatus = fStatus;
    if (fType)
        payload.filterType = fType;
    if (fSprint)
        payload.filterSprint = fSprint;
    if (fAssignee)
        payload.filterAssignee = fAssignee;
    if (uPriority)
        payload.priority = uPriority;
    if (uStatus)
        payload.status = uStatus;
    if (uSprint)
        payload.sprint = uSprint;
    if (uRelease)
        payload.release = uRelease;
    if (uAssignee)
        payload.assignee = uAssignee;
    payload.dryRun = 'true';
    try {
        const data = await api('POST', `/projects/${pid}/pm/update-many`, payload);
        const matched = data.item_plans || data.items || data.matched || [];
        const count = data.matched_count ?? data.count ?? data.total ?? matched.length;
        const applyBtn = document.getElementById('bu-apply-btn');
        if (previewEl) {
            const updateParts = [];
            if (uPriority)
                updateParts.push(`priority → P${uPriority}`);
            if (uStatus)
                updateParts.push(`status → ${uStatus}`);
            if (uSprint)
                updateParts.push(`sprint → ${uSprint}`);
            if (uRelease)
                updateParts.push(`release → ${uRelease}`);
            if (uAssignee)
                updateParts.push(`assignee → ${uAssignee}`);
            const updateDesc = updateParts.map(p => `<strong>${escHtml(p)}</strong>`).join(', ');
            if (count === 0 && matched.length === 0) {
                previewEl.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:10px 0">No items match the filter criteria.</div>`;
                if (applyBtn)
                    applyBtn.disabled = true;
            }
            else {
                const displayCount = count || matched.length;
                previewEl.innerHTML = `
          <div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.25);border-radius:var(--radius);padding:10px 14px;font-size:13px">
            <div style="margin-bottom:8px">Will update <strong>${displayCount}</strong> item${displayCount !== 1 ? 's' : ''}: ${updateDesc}</div>
            ${matched.slice(0, 8).map((it) => `<div style="color:var(--text-secondary);font-size:12px">· ${escHtml(it.id || '')} ${escHtml(it.title || '')}</div>`).join('')}
            ${displayCount > 8 ? `<div style="color:var(--text-muted);font-size:12px;margin-top:4px">… and ${displayCount - 8} more</div>` : ''}
          </div>`;
                if (applyBtn)
                    applyBtn.disabled = false;
                // Store payload for apply (without dryRun)
                const applyPayload = { ...payload };
                delete applyPayload.dryRun;
                applyBtn._bulkPayload = applyPayload;
            }
        }
    }
    catch (err) {
        if (previewEl)
            previewEl.innerHTML = `<div style="color:var(--status-open);font-size:13px">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div>`;
    }
}
export async function applyBulkUpdate() {
    const pid = state.currentProject?.id;
    if (!pid)
        return;
    const applyBtn = document.getElementById('bu-apply-btn');
    const payload = applyBtn?._bulkPayload;
    if (!payload) {
        toast('Run Preview first', 'info');
        return;
    }
    if (applyBtn) {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Applying…';
    }
    try {
        const data = await api('POST', `/projects/${pid}/pm/update-many`, payload);
        const updated = data.updated_count ?? data.updated ?? data.count ?? data.total ?? 'some';
        const failed = data.failed_count ?? 0;
        if (failed > 0) {
            toast(`Updated ${updated} item${updated !== 1 ? 's' : ''} (${failed} failed)`, 'info');
        }
        else {
            toast(`Updated ${updated} item${updated !== 1 ? 's' : ''}`, 'success');
        }
        hideModal('bulk-update-modal');
        if (state.currentView === 'items')
            fetchAndRenderItems();
        loadItemsBadge();
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
        if (applyBtn) {
            applyBtn.disabled = false;
            applyBtn.textContent = 'Apply Update';
        }
    }
}
// ═══════════════════════════════════════════════════════════════
// BULK CLOSE
// ═══════════════════════════════════════════════════════════════
export function showBulkCloseModal() {
    if (!state.currentProject) {
        toast('Select a project first', 'info');
        return;
    }
    createModal('bulk-close-modal', 'Bulk Close Items', `
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Filter Items to Close</div>
      <div class="two-col">
        <div class="form-group">
          <label class="form-label">Current Status</label>
          <select class="form-select" id="bc-filter-status">
            <option value="">Any active status</option>
            ${getStatuses(state.schema).filter(s => s !== 'closed' && s !== 'canceled').map(s => `<option value="${s}">${s.replace('_', ' ')}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Type</label>
          <select class="form-select" id="bc-filter-type">
            <option value="">Any type</option>
            ${getTypes(state.schema).map(t => `<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="two-col">
        <div class="form-group">
          <label class="form-label">Sprint</label>
          <input class="form-input" id="bc-filter-sprint" type="text" placeholder="Filter by sprint…">
        </div>
        <div class="form-group">
          <label class="form-label">Assignee</label>
          <input class="form-input" id="bc-filter-assignee" type="text" placeholder="Filter by assignee…">
        </div>
      </div>
    </div>
    <hr class="section-divider">
    <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Close Action</div>
    <div class="two-col">
      <div class="form-group">
        <label class="form-label">Target Status</label>
        <select class="form-select" id="bc-target-status">
          <option value="closed">closed</option>
          <option value="canceled">canceled</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Reason *</label>
        <input class="form-input" id="bc-reason" type="text" placeholder="Why are these items being closed?">
      </div>
    </div>
    <div id="bc-preview" style="margin-top:12px"></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-secondary" onclick="window.__app.previewBulkClose()">Preview</button>
      <button class="btn btn-danger" id="bc-apply-btn" onclick="window.__app.applyBulkClose()" disabled>Close Items</button>
    </div>`, '');
    showModal('bulk-close-modal');
}
export async function previewBulkClose() {
    const pid = state.currentProject?.id;
    if (!pid)
        return;
    const previewEl = document.getElementById('bc-preview');
    if (previewEl)
        previewEl.innerHTML = '<div class="loading-state" style="padding:12px 0"><div class="loading-spinner"></div></div>';
    const fStatus = document.getElementById('bc-filter-status')?.value || '';
    const fType = document.getElementById('bc-filter-type')?.value || '';
    const fSprint = document.getElementById('bc-filter-sprint')?.value.trim() || '';
    const fAssignee = document.getElementById('bc-filter-assignee')?.value.trim() || '';
    const targetStatus = document.getElementById('bc-target-status')?.value || 'closed';
    const reason = document.getElementById('bc-reason')?.value.trim() || '';
    if (!reason) {
        if (previewEl)
            previewEl.innerHTML = '<div style="color:var(--status-blocked);font-size:13px">A close reason is required.</div>';
        return;
    }
    const payload = { reason: reason, targetStatus };
    if (fStatus)
        payload.filterStatus = fStatus;
    if (fType)
        payload.filterType = fType;
    if (fSprint)
        payload.filterSprint = fSprint;
    if (fAssignee)
        payload.filterAssignee = fAssignee;
    try {
        // Use update-many dry-run to preview which items will be closed/canceled.
        // Dry-run accepts status=closed for preview purposes; actual close uses close-many.
        const previewPayload = { status: targetStatus, dryRun: 'true' };
        if (fStatus)
            previewPayload.filterStatus = fStatus;
        if (fType)
            previewPayload.filterType = fType;
        if (fSprint)
            previewPayload.filterSprint = fSprint;
        if (fAssignee)
            previewPayload.filterAssignee = fAssignee;
        const data = await api('POST', `/projects/${pid}/pm/update-many`, previewPayload);
        const matched = data.item_plans || data.items || data.matched || [];
        const count = data.matched_count ?? data.count ?? data.total ?? matched.length;
        const applyBtn = document.getElementById('bc-apply-btn');
        if (previewEl) {
            if (count === 0 && matched.length === 0) {
                previewEl.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:10px 0">No items match the filter criteria.</div>`;
                if (applyBtn)
                    applyBtn.disabled = true;
            }
            else {
                const displayCount = count || matched.length;
                previewEl.innerHTML = `
          <div style="background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);border-radius:var(--radius);padding:10px 14px;font-size:13px">
            <div style="margin-bottom:8px">Will <strong>${targetStatus}</strong> <strong>${displayCount}</strong> item${displayCount !== 1 ? 's' : ''}. Reason: <em>${escHtml(reason)}</em></div>
            ${matched.slice(0, 8).map((it) => `<div style="color:var(--text-secondary);font-size:12px">· ${escHtml(it.id || '')} ${escHtml(it.title || '')}</div>`).join('')}
            ${displayCount > 8 ? `<div style="color:var(--text-muted);font-size:12px;margin-top:4px">… and ${displayCount - 8} more</div>` : ''}
          </div>`;
                if (applyBtn) {
                    applyBtn.disabled = false;
                    applyBtn._bulkClosePayload = { fStatus, fType, fSprint, fAssignee, targetStatus, reason };
                }
            }
        }
    }
    catch (err) {
        if (previewEl)
            previewEl.innerHTML = `<div style="color:var(--status-blocked);font-size:13px">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div>`;
    }
}
export async function applyBulkClose() {
    const pid = state.currentProject?.id;
    if (!pid)
        return;
    const applyBtn = document.getElementById('bc-apply-btn');
    const bulkClosePayload = applyBtn?._bulkClosePayload;
    if (!bulkClosePayload) {
        toast('Run Preview first', 'info');
        return;
    }
    if (applyBtn) {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Closing…';
    }
    // Use the close-many endpoint which calls pm close <id> <reason> for each matched item.
    // update-many --status closed is rejected by pm CLI; close-many handles it correctly.
    const payload = {
        reason: bulkClosePayload.reason,
        targetStatus: bulkClosePayload.targetStatus,
    };
    if (bulkClosePayload.fStatus)
        payload.filterStatus = bulkClosePayload.fStatus;
    if (bulkClosePayload.fType)
        payload.filterType = bulkClosePayload.fType;
    if (bulkClosePayload.fSprint)
        payload.filterSprint = bulkClosePayload.fSprint;
    if (bulkClosePayload.fAssignee)
        payload.filterAssignee = bulkClosePayload.fAssignee;
    try {
        const data = await api('POST', `/projects/${pid}/pm/close-many`, payload);
        const closed = data.closed_count ?? 'some';
        const failed = data.failed_count ?? 0;
        if (failed > 0) {
            toast(`Closed ${closed} item${closed !== 1 ? 's' : ''} (${failed} failed)`, 'info');
        }
        else {
            toast(`Closed ${closed} item${closed !== 1 ? 's' : ''}`, 'success');
        }
        hideModal('bulk-close-modal');
        if (state.currentView === 'items')
            fetchAndRenderItems();
        loadItemsBadge();
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
        if (applyBtn) {
            applyBtn.disabled = false;
            applyBtn.textContent = 'Close Items';
        }
    }
}
export async function renderItemsView() {
    const el = document.getElementById('content-items');
    if (!el)
        return;
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
        <button class="btn btn-ghost btn-sm" onclick="window.__app.showBulkUpdateModal()">⊞ Bulk Update</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__app.showBulkCloseModal()" title="Close or cancel many items at once">⊘ Bulk Close</button>
        <button class="btn btn-primary" onclick="window.__app.showView('create')">+ New Item</button>
      </div>
    </div>
    <div class="status-tabs" style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
      ${['', 'open', 'in_progress', 'blocked', 'draft', 'closed', 'canceled'].map(s => `<button class="btn btn-sm ${state.itemFilters.status === s ? 'btn-primary' : 'btn-ghost'}" onclick="window.__app.setStatusFilter('${s}')">${s === '' ? 'All' : s.replace('_', ' ')}</button>`).join('')}
    </div>
    <div class="filter-bar">
      <select class="filter-select" id="filter-status" onchange="window.__app.applyItemFilters()">
        <option value="">All Statuses</option>
        ${getStatuses(state.schema).map(s => `<option value="${s}"${state.itemFilters.status === s ? ' selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
      </select>
      <select class="filter-select" id="filter-type" onchange="window.__app.applyItemFilters()">
        <option value="">All Types</option>
        ${getTypes(state.schema).map(t => `<option value="${t}"${state.itemFilters.type === t ? ' selected' : ''}>${t}</option>`).join('')}
      </select>
      <select class="filter-select" id="filter-priority" onchange="window.__app.applyItemFilters()">
        <option value="">All Priorities</option>
        ${[0, 1, 2, 3, 4].map(p => `<option value="${p}"${state.itemFilters.priority == String(p) ? ' selected' : ''}>P${p}: ${PRIORITY_LABELS[p]}</option>`).join('')}
      </select>
      <input class="filter-select" id="filter-sprint" type="text" placeholder="Sprint…" value="${escHtml(state.itemFilters.sprint)}" oninput="window.__app.applyItemFilters()" style="width:100px">
      <input class="filter-select" id="filter-release" type="text" placeholder="Release…" value="${escHtml(state.itemFilters.release)}" oninput="window.__app.applyItemFilters()" style="width:100px">
      <input class="filter-select" id="filter-assignee" type="text" placeholder="Assignee…" value="${escHtml(state.itemFilters.assignee)}" oninput="window.__app.applyItemFilters()" style="width:110px">
      <button class="btn btn-ghost btn-sm" onclick="window.__app.clearFilters()">Clear</button>
    </div>
    <div id="items-list"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;
    await fetchAndRenderItems();
}
export async function fetchAndRenderItems() {
    const pid = state.currentProject?.id;
    if (!pid)
        return;
    const f = state.itemFilters;
    let params = 'limit=200';
    if (f.status)
        params += `&status=${encodeURIComponent(f.status)}`;
    if (f.type)
        params += `&type=${encodeURIComponent(f.type)}`;
    if (f.priority)
        params += `&priority=${encodeURIComponent(f.priority)}`;
    if (f.sprint)
        params += `&sprint=${encodeURIComponent(f.sprint)}`;
    if (f.release)
        params += `&release=${encodeURIComponent(f.release)}`;
    if (f.assignee)
        params += `&assignee=${encodeURIComponent(f.assignee)}`;
    const endpoint = f.status ? `list?${params}` : `list-all?${params}`;
    try {
        const data = await api('GET', `/projects/${pid}/pm/${endpoint}`);
        state.items = data.items || [];
        const sub = document.getElementById('items-subtitle');
        if (sub)
            sub.textContent = `${state.items.length} item${state.items.length !== 1 ? 's' : ''}`;
        renderItemsList();
    }
    catch (err) {
        const listEl = document.getElementById('items-list');
        if (listEl)
            listEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Failed to load items: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
    }
}
function renderItemsList() {
    const el = document.getElementById('items-list');
    if (!el)
        return;
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
export function renderItemRow(item) {
    const tags = (item.tags || []).map(t => `<span class="tag">${escHtml(t)}</span>`).join('');
    return `<div class="item-row" onclick="window.__app.openItemDetail('${escHtml(item.id)}')">
    ${typeIcon(item.type || '')}
    <span class="item-id">${escHtml(item.id)}</span>
    <span class="item-title">${escHtml(item.title)}</span>
    <div class="item-meta">
      ${tags ? `<div class="item-tags">${tags}</div>` : ''}
      ${priorityDot(item.priority ?? 4)}
      ${statusBadge(item.status || 'draft')}
    </div>
  </div>`;
}
export function applyItemFilters() {
    const fs = document.getElementById('filter-status');
    const ft = document.getElementById('filter-type');
    const fp = document.getElementById('filter-priority');
    const fsp = document.getElementById('filter-sprint');
    const frl = document.getElementById('filter-release');
    const fas = document.getElementById('filter-assignee');
    state.itemFilters.status = fs?.value || '';
    state.itemFilters.type = ft?.value || '';
    state.itemFilters.priority = fp?.value || '';
    state.itemFilters.sprint = fsp?.value || '';
    state.itemFilters.release = frl?.value || '';
    state.itemFilters.assignee = fas?.value || '';
    fetchAndRenderItems();
}
export function clearFilters() {
    state.itemFilters = { status: '', type: '', priority: '', sprint: '', release: '', assignee: '' };
    const ids = ['filter-status', 'filter-type', 'filter-priority', 'filter-sprint', 'filter-release', 'filter-assignee'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el)
            el.value = '';
    });
    fetchAndRenderItems();
}
export function setStatusFilter(status) {
    state.itemFilters.status = status;
    renderItemsView();
}
// ═══════════════════════════════════════════════════════════════
// ITEM DETAIL MODAL
// ═══════════════════════════════════════════════════════════════
export async function openItemDetail(itemId) {
    const pid = state.currentProject?.id;
    if (!pid)
        return;
    createModal('item-detail-modal', 'Loading…', '<div class="loading-state"><div class="loading-spinner"></div></div>', '', true);
    showModal('item-detail-modal');
    try {
        const [itemData, commentsData, historyData, depsData, learningsData, notesData, testsData, filesData] = await Promise.all([
            api('GET', `/projects/${pid}/pm/get/${itemId}`),
            api('GET', `/projects/${pid}/pm/comments/${itemId}`).catch(() => ({ comments: [] })),
            api('GET', `/projects/${pid}/pm/history/${itemId}`).catch(() => ({ history: [] })),
            api('GET', `/projects/${pid}/pm/deps/${itemId}`).catch(() => ({ deps: [] })),
            api('GET', `/projects/${pid}/pm/learnings/${itemId}`).catch(() => ({ learnings: [] })),
            api('GET', `/projects/${pid}/pm/notes/${itemId}`).catch(() => ({ notes: [] })),
            api('GET', `/projects/${pid}/pm/tests/${itemId}`).catch(() => ({ tests: [] })),
            api('GET', `/projects/${pid}/pm/files/${itemId}`).catch(() => ({ files: [] })),
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
            if (titleEl)
                titleEl.textContent = item.id;
        }
        const tags = (item.tags || []).map((t) => `<span class="tag">${escHtml(t)}</span>`).join('');
        const notesHtml = notes.length === 0
            ? '<div style="color:var(--text-muted);font-size:13px;margin-bottom:12px">No notes yet</div>'
            : notes.map((n) => `
          <div class="notes-item">
            <div class="notes-item-meta">${relTime(n.timestamp || n.created_at || '')}</div>
            <div class="notes-item-text">${escHtml(n.text || n.content || JSON.stringify(n))}</div>
          </div>`).join('');
        const testsHtml = tests.length === 0
            ? '<div style="color:var(--text-muted);font-size:13px;margin-bottom:12px">No tests defined</div>'
            : tests.map((t) => `
          <div class="test-item">
            <div style="flex:1">
              <div class="test-item-cmd">${escHtml(t.command || t.cmd || JSON.stringify(t))}</div>
              ${t.description ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:3px">${escHtml(t.description)}</div>` : ''}
            </div>
          </div>`).join('');
        const commentsHtml = comments.length === 0
            ? '<div style="color:var(--text-muted);font-size:13px">No comments yet</div>'
            : comments.map((c) => `
          <div class="comment-item">
            <div class="comment-avatar">💬</div>
            <div class="comment-body">
              <div class="comment-meta">${fmtDate(c.timestamp || c.created_at)}</div>
              <div class="comment-text">${escHtml(c.text || c.content || c.body || JSON.stringify(c))}</div>
            </div>
          </div>`).join('');
        const historyHtml = history.length === 0
            ? '<div style="color:var(--text-muted);font-size:13px">No history</div>'
            : history.slice(0, 10).map((h) => `
          <div class="history-item">
            <div class="history-dot"></div>
            <div><div class="history-text">${escHtml(h.message || h.action || JSON.stringify(h))}</div><div class="history-time">${relTime(h.timestamp || h.created_at)}</div></div>
          </div>`).join('');
        const bodyEl = modal?.querySelector('.modal-body');
        if (bodyEl) {
            bodyEl.innerHTML = `
      <div class="item-detail-header">
        <div class="item-detail-id">${typeIcon(item.type || '')} ${escHtml(item.type)} · ${escHtml(item.id)}</div>
        <div class="item-detail-title">${escHtml(item.title)}</div>
        <div class="item-detail-meta">
          ${statusBadge(item.status || 'draft')}
          <div class="meta-chip">${priorityDot(item.priority ?? 4)} <strong>P${item.priority}</strong> ${PRIORITY_LABELS[item.priority] || ''}</div>
          ${item.created_at ? `<div class="meta-chip">Created <strong>${fmtDate(item.created_at)}</strong></div>` : ''}
          ${item.updated_at ? `<div class="meta-chip">Updated <strong>${relTime(item.updated_at)}</strong></div>` : ''}
          ${item.parent ? `<div class="meta-chip">Parent <strong class="mono">${escHtml(item.parent)}</strong></div>` : ''}
          ${item.claimedBy ? `<div class="meta-chip">Claimed by <strong>${escHtml(item.claimedBy)}</strong></div>` : ''}
          ${item.deadline ? `<div class="meta-chip">Due <strong>${fmtDate(item.deadline)}</strong></div>` : ''}
          ${item.assignee ? `<div class="meta-chip">Assignee <strong>${escHtml(item.assignee)}</strong></div>` : ''}
          ${item.sprint ? `<div class="meta-chip">Sprint <strong>${escHtml(item.sprint)}</strong></div>` : ''}
          ${item.release ? `<div class="meta-chip">Release <strong>${escHtml(item.release)}</strong></div>` : ''}
          ${item.estimated_minutes ? `<div class="meta-chip">~${item.estimated_minutes}m</div>` : ''}
          ${item.blockedBy || item['blocked-by'] ? `<div class="meta-chip" style="border-color:rgba(248,113,113,0.4);color:#f87171">Blocked by <strong class="mono">${escHtml(item.blockedBy || item['blocked-by'] || '')}</strong></div>` : ''}
          ${tags ? `<div class="item-tags">${tags}</div>` : ''}
        </div>
        <div class="claim-btn-wrap">
          <button class="btn btn-secondary btn-sm" onclick="window.__app.claimItem('${escHtml(itemId)}')">⊕ Claim</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__app.releaseItem('${escHtml(itemId)}')">⊖ Release</button>
          ${item.status === 'open' ? `<button class="btn btn-secondary btn-sm" onclick="window.__app.startItem('${escHtml(itemId)}')">▶ Start</button>` : ''}
          ${item.status === 'in_progress' ? `<button class="btn btn-ghost btn-sm" onclick="window.__app.pauseItem('${escHtml(itemId)}')">⏸ Pause</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="window.__app.useItemAsTemplate(${JSON.stringify(item)})" title="Open create form pre-filled with this item's fields">⊡ Use as Template</button>
        </div>
      </div>

      ${item.description ? `
        <div class="item-detail-section">
          <div class="item-detail-section-title">Description</div>
          <div class="item-detail-desc">${escHtml(item.description)}</div>
        </div>` : ''}

      ${(item.blockedReason || item['blocked-reason']) ? `
        <div class="item-detail-section" style="background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);border-radius:var(--radius);padding:12px 14px;margin-bottom:16px">
          <div class="item-detail-section-title" style="color:#f87171">Blocked Reason</div>
          <div class="item-detail-desc">${escHtml(item.blockedReason || item['blocked-reason'] || '')}</div>
        </div>` : ''}

      ${item.acceptance_criteria || item.acceptanceCriteria ? `
        <div class="item-detail-section">
          <div class="item-detail-section-title">Acceptance Criteria</div>
          <div class="item-detail-desc">${escHtml(item.acceptance_criteria || item.acceptanceCriteria || '')}</div>
        </div>` : ''}

      <div class="tabs">
        <div class="tab active" onclick="window.__app.switchDetailTab(this,'tab-comments')">Comments (${comments.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-update')">Update</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-notes')">Notes (${notes.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-deps')">Deps (${deps.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-graph','${escHtml(itemId)}')">◎ Graph</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-learnings')">Learnings (${learnings.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-tests')">Tests (${tests.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-files')">Files (${files.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-history')">History</div>
        ${item.status !== 'closed' && item.status !== 'canceled' ? `<div class="tab" onclick="window.__app.switchDetailTab(this,'tab-close')">Close</div>` : ''}
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
              ${getStatuses(state.schema).map(s => `<option value="${s}"${item.status === s ? ' selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Priority</label>
            <select class="form-select" id="edit-priority">
              ${[0, 1, 2, 3, 4].map(p => `<option value="${p}"${item.priority == p ? ' selected' : ''}>P${p}: ${PRIORITY_LABELS[p]}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Tags (comma-separated)</label>
          <input class="form-input" id="edit-tags" type="text" value="${escHtml((item.tags || []).join(', '))}">
        </div>
        <div class="two-col">
          <div class="form-group">
            <label class="form-label">Deadline</label>
            <input class="form-input" id="edit-deadline" type="text" placeholder="+1d, +1w, 2026-06-01" value="${escHtml(item.deadline || '')}">
          </div>
          <div class="form-group">
            <label class="form-label">Assignee</label>
            <input class="form-input" id="edit-assignee" type="text" value="${escHtml(item.assignee || '')}">
          </div>
        </div>
        <div class="two-col">
          <div class="form-group">
            <label class="form-label">Sprint</label>
            <input class="form-input" id="edit-sprint" type="text" value="${escHtml(item.sprint || '')}">
          </div>
          <div class="form-group">
            <label class="form-label">Release</label>
            <input class="form-input" id="edit-release" type="text" value="${escHtml(item.release || '')}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Estimated Minutes</label>
          <input class="form-input" id="edit-estimate" type="number" min="1" value="${escHtml(String(item.estimated_minutes || ''))}">
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <textarea class="form-textarea" id="edit-desc" rows="4">${escHtml(item.description || '')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Body (extended)</label>
          <textarea class="form-textarea" id="edit-body" rows="3">${escHtml(item.body || '')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Acceptance Criteria</label>
          <textarea class="form-textarea" id="edit-acceptance-criteria" rows="2">${escHtml(item.acceptance_criteria || item.acceptanceCriteria || '')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Blocked Reason</label>
          <textarea class="form-textarea" id="edit-blocked-reason" rows="2" placeholder="Why is this item blocked?">${escHtml(item.blockedReason || item['blocked-reason'] || '')}</textarea>
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
                : deps.map((dep) => {
                    const target = depTargetId(dep);
                    const rel = depRelation(dep);
                    const title = dep.targetTitle || dep.title || '';
                    return `<div class="dep-row">
                <span class="dep-rel">${escHtml(depLabel(rel))}</span>
                <span class="dep-id" onclick="window.__app.hideModal('item-detail-modal');window.__app.openItemDetail('${escHtml(target)}')">
                  ${escHtml(target)}
                </span>
                <span style="flex:1;color:var(--text-secondary);font-size:12px">${escHtml(String(title))}</span>
                <button class="btn btn-danger btn-sm" onclick="window.__app.removeDep('${escHtml(itemId)}','${escHtml(target)}','${escHtml(rel)}')">Remove</button>
              </div>`;
                }).join('')}
        </div>
        <hr class="section-divider">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Add Dependency</div>
        <div class="row" style="margin-bottom:8px">
          <input class="form-input flex-1" id="dep-target-id" type="text" placeholder="Item ID (e.g. ${escHtml(state.currentProject?.prefix || 'proj')}-5)">
          <select class="form-select" id="dep-rel" style="width:200px">
            ${renderDependencyOptions()}
          </select>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__app.addDep('${escHtml(itemId)}')">Add Dependency</button>
      </div>

      <div id="tab-learnings" style="display:none">
        <div style="margin-bottom:16px">
          ${learnings.length === 0
                ? `<div style="color:var(--text-muted);font-size:13px;margin-bottom:12px">No learnings recorded</div>`
                : learnings.map((l) => `<div class="learning-row">
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">${relTime(l.timestamp || l.created_at || '')}</div>
                ${escHtml(l.text || l.content || JSON.stringify(l))}
              </div>`).join('')}
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

      <!-- Local graph tab -->
      <div id="tab-graph" style="display:none">
        <div class="local-graph-controls" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:12px;color:var(--text-muted)">Depth</span>
          <input type="range" id="local-graph-depth" min="1" max="5" step="1" value="2" class="graph-depth-slider" style="width:100px">
          <span id="local-graph-depth-val" style="font-size:11px;color:var(--accent);font-family:'JetBrains Mono',monospace;min-width:12px">2</span>
          <button class="btn btn-ghost btn-sm" onclick="window.__app.openGraphAt('${escHtml(itemId)}')" title="Open in full graph view" style="margin-left:auto">Full graph →</button>
        </div>
        <div id="local-graph-canvas" style="height:320px;border-radius:8px;overflow:hidden;background:#080d1a;border:1px solid rgba(148,163,184,0.12)"></div>
      </div>

      <div id="tab-files" style="display:none">
        <div style="margin-bottom:16px">
          ${files.length === 0
                ? '<div style="color:var(--text-muted);font-size:13px;margin-bottom:12px">No files linked</div>'
                : files.map((f) => `
                <div class="file-row">
                  <span style="color:var(--text-muted)">📄</span>
                  <span class="file-path">${escHtml(f.path || f.name || JSON.stringify(f))}</span>
                  ${f.scope ? `<span style="font-size:10px;color:var(--text-muted);background:var(--bg-input);padding:2px 6px;border-radius:4px">${escHtml(f.scope)}</span>` : ''}
                </div>`).join('')}
        </div>
        <hr class="section-divider">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Link File</div>
        <div class="row" style="margin-bottom:8px">
          <input class="form-input flex-1" id="file-path-input" type="text" placeholder="src/components/App.tsx">
          <button class="btn btn-primary btn-sm" onclick="window.__app.addFileLink('${escHtml(itemId)}')">Add</button>
        </div>
      </div>

      ${item.status !== 'closed' && item.status !== 'canceled' ? `
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
      </div>` : ''}
    `;
        }
    }
    catch (err) {
        const bodyEl = document.getElementById('item-detail-modal')?.querySelector('.modal-body');
        if (bodyEl)
            bodyEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Failed to load: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
    }
}
function relTime(ts) {
    if (!ts)
        return '';
    const d = new Date(ts);
    const diff = Date.now() - d.getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60)
        return 'just now';
    if (s < 3600)
        return `${Math.floor(s / 60)}m ago`;
    if (s < 86400)
        return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800)
        return `${Math.floor(s / 86400)}d ago`;
    return d.toLocaleDateString();
}
function fmtDate(ts) {
    if (!ts)
        return '';
    return new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
export function switchDetailTab(tabEl, targetId, nodeId) {
    const allTabs = tabEl.parentElement?.querySelectorAll('.tab');
    allTabs?.forEach(t => t.classList.remove('active'));
    tabEl.classList.add('active');
    const ids = ['tab-comments', 'tab-update', 'tab-notes', 'tab-deps', 'tab-graph', 'tab-learnings', 'tab-tests', 'tab-files', 'tab-history', 'tab-close'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el)
            el.style.display = id === targetId ? '' : 'none';
        // Clean up local graph canvas when switching away
        if (id === 'tab-graph' && id !== targetId)
            destroyLocalGraph('local-graph-canvas');
    });
    // Initialize local graph when tab is opened
    if (targetId === 'tab-graph' && nodeId) {
        const depthSlider = document.getElementById('local-graph-depth');
        const depthVal = document.getElementById('local-graph-depth-val');
        const depth = depthSlider ? parseInt(depthSlider.value, 10) : 2;
        void renderLocalGraph('local-graph-canvas', nodeId, depth);
        depthSlider?.addEventListener('input', () => {
            const d = parseInt(depthSlider.value, 10);
            if (depthVal)
                depthVal.textContent = String(d);
            void renderLocalGraph('local-graph-canvas', nodeId, d);
        });
    }
}
export async function addComment(itemId) {
    const el = document.getElementById('new-comment');
    if (!el)
        return;
    const text = el.value.trim();
    if (!text) {
        toast('Comment cannot be empty', 'error');
        return;
    }
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/comments/${itemId}`, { text });
        toast('Comment added', 'success');
        el.value = '';
        openItemDetail(itemId);
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
    }
}
export async function addNote(itemId) {
    const el = document.getElementById('new-note');
    if (!el)
        return;
    const text = el.value.trim();
    if (!text) {
        toast('Note cannot be empty', 'error');
        return;
    }
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/notes/${itemId}`, { text });
        toast('Note added', 'success');
        el.value = '';
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
    }
}
export async function appendItem(itemId) {
    const el = document.getElementById('new-append');
    if (!el)
        return;
    const text = el.value.trim();
    if (!text) {
        toast('Text cannot be empty', 'error');
        return;
    }
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/append/${itemId}`, { text });
        toast('Appended', 'success');
        el.value = '';
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
    }
}
export async function updateItem(itemId) {
    const titleEl = document.getElementById('edit-title');
    const statusEl = document.getElementById('edit-status');
    const priorityEl = document.getElementById('edit-priority');
    const tagsEl = document.getElementById('edit-tags');
    const descEl = document.getElementById('edit-desc');
    const deadlineEl = document.getElementById('edit-deadline');
    const assigneeEl = document.getElementById('edit-assignee');
    const sprintEl = document.getElementById('edit-sprint');
    const releaseEl = document.getElementById('edit-release');
    const estimateEl = document.getElementById('edit-estimate');
    const bodyEl = document.getElementById('edit-body');
    const acEl = document.getElementById('edit-acceptance-criteria');
    const blockedReasonEl = document.getElementById('edit-blocked-reason');
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
    const blockedReason = blockedReasonEl?.value.trim() || '';
    if (!title) {
        toast('Title required', 'error');
        return;
    }
    try {
        const payload = { title, status, priority, tags, description };
        if (deadline)
            payload.deadline = deadline;
        if (assignee)
            payload.assignee = assignee;
        if (sprint)
            payload.sprint = sprint;
        if (release)
            payload.release = release;
        if (estimate)
            payload.estimate = estimate;
        if (body)
            payload.body = body;
        if (acceptanceCriteria)
            payload.acceptanceCriteria = acceptanceCriteria;
        if (blockedReason)
            payload.blockedReason = blockedReason;
        await api('PATCH', `/projects/${state.currentProject.id}/pm/update/${itemId}`, payload);
        toast('Item updated', 'success');
        openItemDetail(itemId);
        if (state.currentView === 'items')
            fetchAndRenderItems();
        loadItemsBadge();
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
    }
}
export async function closeItem(itemId, targetStatus) {
    const reasonEl = document.getElementById('close-reason');
    const reason = reasonEl?.value?.trim();
    if (!reason) {
        toast('Close reason is required', 'error');
        return;
    }
    try {
        if (targetStatus === 'canceled') {
            await api('PATCH', `/projects/${state.currentProject.id}/pm/update/${itemId}`, { status: 'canceled' });
            await api('POST', `/projects/${state.currentProject.id}/pm/close/${itemId}`, { reason });
        }
        else {
            await api('POST', `/projects/${state.currentProject.id}/pm/close/${itemId}`, { reason });
        }
        toast(`Item ${targetStatus}`, 'success');
        hideModal('item-detail-modal');
        if (state.currentView === 'items')
            fetchAndRenderItems();
        loadItemsBadge();
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
    }
}
export function confirmDeleteItem(itemId) {
    confirmDialog('Delete Item?', 'This action cannot be undone. The item and all its data will be permanently removed.', async () => {
        try {
            await api('DELETE', `/projects/${state.currentProject.id}/pm/delete/${itemId}`);
            toast('Item deleted', 'success');
            hideModal('item-detail-modal');
            if (state.currentView === 'items')
                fetchAndRenderItems();
            loadItemsBadge();
        }
        catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'error');
        }
    }, true);
}
// ═══════════════════════════════════════════════════════════════
// CLAIM / RELEASE / START / PAUSE
// ═══════════════════════════════════════════════════════════════
export async function claimItem(itemId) {
    const row = document.querySelector(`.item-row[onclick*="${itemId}"]`);
    if (row)
        row.style.opacity = '0.6';
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/claim/${itemId}`, {});
        toast('Item claimed', 'success');
        openItemDetail(itemId);
        if (state.currentView === 'items')
            fetchAndRenderItems();
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
        if (row)
            row.style.opacity = '';
    }
}
export async function releaseItem(itemId) {
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/release/${itemId}`, {});
        toast('Item released', 'success');
        openItemDetail(itemId);
        if (state.currentView === 'items')
            fetchAndRenderItems();
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
    }
}
export async function startItem(itemId) {
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/start-task/${itemId}`, {});
        toast('Item started', 'success');
        openItemDetail(itemId);
        if (state.currentView === 'items')
            fetchAndRenderItems();
        loadItemsBadge();
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
    }
}
export async function pauseItem(itemId) {
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/pause-task/${itemId}`, {});
        toast('Item paused', 'success');
        openItemDetail(itemId);
        if (state.currentView === 'items')
            fetchAndRenderItems();
        loadItemsBadge();
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
    }
}
// ═══════════════════════════════════════════════════════════════
// DEPS / LEARNINGS / TESTS / FILES
// ═══════════════════════════════════════════════════════════════
export async function addDep(itemId) {
    const targetIdEl = document.getElementById('dep-target-id');
    const relEl = document.getElementById('dep-rel');
    const targetId = targetIdEl?.value?.trim() || '';
    const rel = normalizeDepRelation(relEl?.value || 'blocked_by');
    if (!targetId) {
        toast('Target item ID is required', 'error');
        return;
    }
    if (targetId === itemId) {
        toast('A dependency cannot target the same item', 'error');
        return;
    }
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/deps/${itemId}`, { targetId, rel });
        toast('Dependency added', 'success');
        openItemDetail(itemId);
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
    }
}
export async function removeDep(itemId, targetId, relation) {
    const rel = normalizeDepRelation(relation);
    if (!targetId) {
        toast('Target item ID is required', 'error');
        return;
    }
    confirmDialog(`Remove dependency ${rel}?`, `This will remove the ${rel} dependency between ${itemId} and ${targetId}.`, async () => {
        try {
            await api('DELETE', `/projects/${state.currentProject.id}/pm/deps/${itemId}`, { targetId, rel });
            toast('Dependency removed', 'success');
            openItemDetail(itemId);
        }
        catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'error');
        }
    }, true);
}
export async function addLearning(itemId) {
    const el = document.getElementById('new-learning');
    const text = el?.value?.trim() || '';
    if (!text) {
        toast('Learning text is required', 'error');
        return;
    }
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/learnings/${itemId}`, { text });
        toast('Learning recorded', 'success');
        openItemDetail(itemId);
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
    }
}
export async function addTest(itemId) {
    const cmdEl = document.getElementById('new-test-cmd');
    const descEl = document.getElementById('new-test-desc');
    const command = cmdEl?.value?.trim() || '';
    const description = descEl?.value?.trim() || '';
    if (!command) {
        toast('Test command is required', 'error');
        return;
    }
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/tests/${itemId}`, { command, description });
        toast('Test added', 'success');
        openItemDetail(itemId);
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
    }
}
export async function addFileLink(itemId) {
    const el = document.getElementById('file-path-input');
    const filePath = el?.value?.trim() || '';
    if (!filePath) {
        toast('File path is required', 'error');
        return;
    }
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/files/${itemId}`, { path: filePath });
        toast('File linked', 'success');
        openItemDetail(itemId);
    }
    catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
    }
}
// ═══════════════════════════════════════════════════════════════
// USE ITEM AS TEMPLATE
// ═══════════════════════════════════════════════════════════════
export function useItemAsTemplate(item) {
    // Close the item detail modal and navigate to create view
    hideModal('item-detail-modal');
    showView('create');
    // Give the create view time to render, then fill fields
    setTimeout(() => {
        const setVal = (id, val) => {
            if (!val)
                return;
            const el = document.getElementById(id);
            if (el)
                el.value = val;
        };
        // Pre-fill create form from item fields (title gets "Copy of …" prefix)
        const origTitle = String(item['title'] || '');
        setVal('ci-title', origTitle ? `Copy of ${origTitle}` : '');
        setVal('ci-type', String(item['type'] || ''));
        setVal('ci-priority', String(item['priority'] || ''));
        const tags = Array.isArray(item['tags']) ? item['tags'].join(', ') : String(item['tags'] || '');
        setVal('ci-tags', tags);
        setVal('ci-desc', String(item['description'] || ''));
        setVal('ci-sprint', String(item['sprint'] || ''));
        setVal('ci-release', String(item['release'] || ''));
        setVal('ci-assignee', String(item['assignee'] || ''));
        if (item['acceptance_criteria'] || item['acceptanceCriteria']) {
            setVal('ci-acceptance-criteria', String(item['acceptance_criteria'] || item['acceptanceCriteria'] || ''));
        }
        if (item['body']) {
            setVal('ci-body', String(item['body']));
        }
        document.getElementById('ci-title')?.focus();
        // Select all title text so user can immediately replace or refine
        const titleEl = document.getElementById('ci-title');
        titleEl?.select();
        toast('Create form pre-filled from item', 'success');
    }, 150);
}
//# sourceMappingURL=items.js.map