// ═══════════════════════════════════════════════════════════════
// PLAN VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';
import { showModal, hideModal, createModal, confirmDialog } from '../components/modals.js';
// ─── State ───────────────────────────────────────────────────
let currentPlanId = null;
// ─── Helpers ─────────────────────────────────────────────────
function stepRef(step) {
    return step.ref || step.id || '';
}
function stepStatusBadge(status) {
    const s = (status || 'pending').toLowerCase();
    const colors = {
        done: 'var(--status-closed)',
        completed: 'var(--status-closed)',
        blocked: 'var(--status-blocked)',
        in_progress: 'var(--status-in-progress)',
        pending: 'var(--text-muted)',
        open: 'var(--accent)',
    };
    const color = colors[s] || 'var(--text-muted)';
    return `<span style="font-size:11px;padding:2px 7px;border-radius:4px;background:color-mix(in srgb,${color} 18%,transparent);color:${color};font-weight:600;letter-spacing:.3px">${escHtml(s)}</span>`;
}
function renderStepRow(step, planId) {
    const ref = stepRef(step);
    const isDone = ['done', 'completed'].includes((step.status || '').toLowerCase());
    const isBlocked = (step.status || '').toLowerCase() === 'blocked';
    return `
    <div class="plan-step-row" data-step-ref="${escHtml(ref)}">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--text-muted);font-family:'JetBrains Mono',monospace">${escHtml(ref)}</span>
          <span style="font-size:13px;font-weight:500;${isDone ? 'text-decoration:line-through;color:var(--text-muted)' : ''}">${escHtml(step.title || '(untitled)')}</span>
          ${stepStatusBadge(step.status)}
        </div>
        ${step.description ? `<div style="font-size:12px;color:var(--text-muted);margin-top:3px">${escHtml(step.description)}</div>` : ''}
        ${isBlocked && (step.blockedReason || step.blocked_reason) ? `<div style="font-size:12px;color:var(--status-blocked);margin-top:3px">Blocked: ${escHtml(step.blockedReason || step.blocked_reason || '')}</div>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        ${!isDone ? `<button class="btn btn-ghost btn-sm" onclick="window.__app.planCompleteStep('${escHtml(planId)}','${escHtml(ref)}')" title="Mark complete">✓</button>` : ''}
        ${!isBlocked && !isDone ? `<button class="btn btn-ghost btn-sm" onclick="window.__app.planBlockStepPrompt('${escHtml(planId)}','${escHtml(ref)}')" title="Block">⊘</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="window.__app.planRemoveStep('${escHtml(planId)}','${escHtml(ref)}')" title="Remove" style="color:var(--danger,#f87171)">✕</button>
      </div>
    </div>`;
}
// ─── Render ──────────────────────────────────────────────────
export function renderPlanView() {
    return `
    <div class="page-header">
      <div>
        <div class="page-title">Plans</div>
        <div class="page-subtitle" id="plan-subtitle">Loading…</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary btn-sm" onclick="window.__app.openCreatePlanModal()">+ New Plan</button>
        <button class="btn btn-secondary btn-sm" onclick="window.__app.initPlanView()">↺ Refresh</button>
      </div>
    </div>
    <div class="plan-layout">
      <div class="plan-list-panel">
        <div id="plan-list-panel"><div class="loading-state"><div class="loading-spinner"></div></div></div>
      </div>
      <div class="plan-detail-panel">
        <div id="plan-detail-panel">
          <div class="empty-state"><div class="empty-state-text">Select a plan to view its steps</div></div>
        </div>
      </div>
    </div>`;
}
export async function initPlanView() {
    const el = document.getElementById('content-plan');
    if (!el)
        return;
    if (!state.currentProject) {
        el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>';
        return;
    }
    el.innerHTML = renderPlanView();
    await loadPlanList();
}
async function loadPlanList() {
    const listEl = document.getElementById('plan-list-panel');
    const subEl = document.getElementById('plan-subtitle');
    if (!listEl || !state.currentProject)
        return;
    listEl.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await api('GET', `/projects/${state.currentProject.id}/pm/list-all?type=Plan`);
        const items = (data.items || []);
        if (subEl)
            subEl.textContent = state.currentProject.name;
        if (items.length === 0) {
            listEl.innerHTML = '<div class="empty-state" style="padding:16px"><div class="empty-state-text">No plans yet</div></div>';
            return;
        }
        listEl.innerHTML = `<div class="card" style="padding:0">
      ${items.map(item => `
        <div class="sidebar-item" style="padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer"
          onclick="window.__app.openPlanDetail('${escHtml(item.id || '')}')"
          data-plan-id="${escHtml(item.id || '')}">
          <div style="font-size:13px;font-weight:500">${escHtml(item.title || '(untitled)')}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;display:flex;gap:6px;align-items:center">
            <span style="font-family:'JetBrains Mono',monospace">${escHtml(item.id || '')}</span>
            ${stepStatusBadge(item.status)}
          </div>
        </div>`).join('')}
    </div>`;
    }
    catch (err) {
        listEl.innerHTML = `<div class="empty-state" style="padding:16px"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
    }
}
export async function openPlanDetail(planId) {
    currentPlanId = planId;
    // Highlight selected in list
    document.querySelectorAll('#plan-list-panel [data-plan-id]').forEach(el => {
        el.style.background = el.dataset.planId === planId ? 'var(--bg-elevated)' : '';
    });
    const detailEl = document.getElementById('plan-detail-panel');
    if (!detailEl || !state.currentProject)
        return;
    detailEl.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await api('GET', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}`);
        const plan = (data.plan || data);
        const steps = plan.steps || [];
        const isApproved = !!(plan.approvedAt || plan.approved_at);
        detailEl.innerHTML = `
      <div class="card">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div>
            <div class="card-title">${escHtml(plan.title || planId)}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px;font-family:'JetBrains Mono',monospace">${escHtml(plan.id || planId)}</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${!isApproved ? `<button class="btn btn-secondary btn-sm" onclick="window.__app.planApprove('${escHtml(planId)}')">✓ Approve</button>` : '<span style="font-size:12px;color:var(--status-closed)">✓ Approved</span>'}
            <button class="btn btn-primary btn-sm" onclick="window.__app.planMaterializePrompt('${escHtml(planId)}')">⇗ Materialize</button>
            <button class="btn btn-ghost btn-sm" onclick="window.__app.planEditPrompt('${escHtml(planId)}','${escHtml(plan.title || '')}')" title="Edit plan">✎</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--danger,#f87171)" onclick="window.__app.planDeletePrompt('${escHtml(planId)}')" title="Delete plan">✕</button>
          </div>
        </div>
        <div class="card-body">
          ${plan.description ? `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">${escHtml(plan.description)}</div>` : ''}
          ${plan.scope ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Scope: ${escHtml(plan.scope)}</div>` : ''}
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div style="font-size:13px;font-weight:600">Steps (${steps.length})</div>
            <button class="btn btn-ghost btn-sm" onclick="window.__app.openAddStepModal('${escHtml(planId)}')">+ Add Step</button>
          </div>
          <div id="plan-steps-list">
            ${steps.length === 0
            ? '<div style="font-size:13px;color:var(--text-muted);padding:8px 0">No steps yet. Add the first step to get started.</div>'
            : steps.map(s => renderStepRow(s, planId)).join('')}
          </div>
        </div>
      </div>`;
    }
    catch (err) {
        detailEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
    }
}
// ─── Modal builders ──────────────────────────────────────────
export function openCreatePlanModal() {
    if (!state.currentProject) {
        toast('Select a project first', 'info');
        return;
    }
    createModal('create-plan-modal', 'New Plan', `
    <div class="form-group">
      <label class="form-label">Title *</label>
      <input class="form-input" id="plan-title" type="text" placeholder="Plan title" autofocus required>
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <textarea class="form-textarea" id="plan-desc" rows="3" placeholder="What is this plan for?"></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Scope</label>
      <input class="form-input" id="plan-scope" type="text" placeholder="e.g. backend, v2, sprint-3">
    </div>
    <div class="two-col">
      <div class="form-group">
        <label class="form-label">Tags</label>
        <input class="form-input" id="plan-tags" type="text" placeholder="comma, separated">
      </div>
      <div class="form-group">
        <label class="form-label">Priority</label>
        <select class="form-select" id="plan-priority">
          <option value="">Default</option>
          <option value="1">P1: Critical</option>
          <option value="2">P2: High</option>
          <option value="3" selected>P3: Medium</option>
          <option value="4">P4: Low</option>
          <option value="5">P5: Minimal</option>
        </select>
      </div>
    </div>`, `<button class="btn btn-primary" onclick="window.__app.submitCreatePlan()">Create Plan</button>
     <button class="btn btn-ghost" onclick="window.__app.hideModal('create-plan-modal')">Cancel</button>`);
    showModal('create-plan-modal');
}
export async function submitCreatePlan() {
    if (!state.currentProject)
        return;
    const title = document.getElementById('plan-title')?.value?.trim();
    if (!title) {
        toast('Title is required', 'error');
        return;
    }
    const description = document.getElementById('plan-desc')?.value?.trim() || '';
    const scope = document.getElementById('plan-scope')?.value?.trim() || '';
    const tags = document.getElementById('plan-tags')?.value?.trim() || '';
    const priority = document.getElementById('plan-priority')?.value || '';
    const body = { title };
    if (description)
        body.description = description;
    if (scope)
        body.scope = scope;
    if (tags)
        body.tags = tags;
    if (priority)
        body.priority = priority;
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/plan`, body);
        hideModal('create-plan-modal');
        toast('Plan created', 'success');
        await loadPlanList();
    }
    catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to create plan', 'error');
    }
}
export function openAddStepModal(planId) {
    createModal('add-step-modal', 'Add Step', `
    <div class="form-group">
      <label class="form-label">Title *</label>
      <input class="form-input" id="step-title" type="text" placeholder="Step title" autofocus required>
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <textarea class="form-textarea" id="step-desc" rows="2" placeholder="Optional step description"></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Depends On (step refs, comma-separated)</label>
      <input class="form-input" id="step-depends" type="text" placeholder="e.g. step-001,step-002">
    </div>`, `<button class="btn btn-primary" onclick="window.__app.submitAddStep('${escHtml(planId)}')">Add Step</button>
     <button class="btn btn-ghost" onclick="window.__app.hideModal('add-step-modal')">Cancel</button>`);
    showModal('add-step-modal');
}
export async function submitAddStep(planId) {
    if (!state.currentProject)
        return;
    const title = document.getElementById('step-title')?.value?.trim();
    if (!title) {
        toast('Title is required', 'error');
        return;
    }
    const description = document.getElementById('step-desc')?.value?.trim() || '';
    const dependsOn = document.getElementById('step-depends')?.value?.trim() || '';
    const body = { title };
    if (description)
        body.description = description;
    if (dependsOn)
        body.dependsOn = dependsOn;
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}/steps`, body);
        hideModal('add-step-modal');
        toast('Step added', 'success');
        await openPlanDetail(planId);
    }
    catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to add step', 'error');
    }
}
export async function planCompleteStep(planId, stepRef) {
    if (!state.currentProject)
        return;
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepRef)}/complete`, {});
        toast('Step completed', 'success');
        await openPlanDetail(planId);
    }
    catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to complete step', 'error');
    }
}
export function planBlockStepPrompt(planId, stepRef) {
    createModal('block-step-modal', 'Block Step', `
    <div class="form-group">
      <label class="form-label">Reason *</label>
      <input class="form-input" id="block-reason" type="text" placeholder="Why is this step blocked?" autofocus required>
    </div>`, `<button class="btn btn-primary" onclick="window.__app.submitBlockStep('${escHtml(planId)}','${escHtml(stepRef)}')">Block Step</button>
     <button class="btn btn-ghost" onclick="window.__app.hideModal('block-step-modal')">Cancel</button>`);
    showModal('block-step-modal');
}
export async function submitBlockStep(planId, stepRef) {
    if (!state.currentProject)
        return;
    const reason = document.getElementById('block-reason')?.value?.trim();
    if (!reason) {
        toast('Reason is required', 'error');
        return;
    }
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepRef)}/block`, { reason });
        hideModal('block-step-modal');
        toast('Step blocked', 'success');
        await openPlanDetail(planId);
    }
    catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to block step', 'error');
    }
}
export function planRemoveStep(planId, stepRef) {
    confirmDialog('Remove step', `Remove step ${stepRef} from plan?`, async () => {
        if (!state.currentProject)
            return;
        try {
            await api('DELETE', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepRef)}`, {});
            toast('Step removed', 'success');
            await openPlanDetail(planId);
        }
        catch (err) {
            toast(err instanceof Error ? err.message : 'Failed to remove step', 'error');
        }
    }, true);
}
export function planApprove(planId) {
    confirmDialog('Approve plan', `Approve plan ${planId}? Once approved, it can be materialized.`, async () => {
        if (!state.currentProject)
            return;
        try {
            await api('POST', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}/approve`, {});
            toast('Plan approved', 'success');
            await openPlanDetail(planId);
        }
        catch (err) {
            toast(err instanceof Error ? err.message : 'Failed to approve plan', 'error');
        }
    });
}
export function planMaterializePrompt(planId) {
    createModal('materialize-plan-modal', 'Materialize Plan', `
    <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">Materializing creates real project items from plan steps.</p>
    <div class="form-group">
      <label class="form-label">Item Type</label>
      <select class="form-select" id="mat-type">
        <option value="">Default (Task)</option>
        <option value="Task">Task</option>
        <option value="Feature">Feature</option>
        <option value="Issue">Issue</option>
        <option value="Chore">Chore</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Parent Item ID (optional)</label>
      <input class="form-input" id="mat-parent" type="text" placeholder="e.g. PROJ-5">
    </div>
    <div class="form-group">
      <label class="form-label">Steps to materialize (comma-separated, leave blank for all)</label>
      <input class="form-input" id="mat-steps" type="text" placeholder="e.g. step-001,step-002">
    </div>`, `<button class="btn btn-primary" onclick="window.__app.submitMaterializePlan('${escHtml(planId)}')">Materialize</button>
     <button class="btn btn-ghost" onclick="window.__app.hideModal('materialize-plan-modal')">Cancel</button>`);
    showModal('materialize-plan-modal');
}
export async function submitMaterializePlan(planId) {
    if (!state.currentProject)
        return;
    const materializeType = document.getElementById('mat-type')?.value || '';
    const materializeParent = document.getElementById('mat-parent')?.value?.trim() || '';
    const steps = document.getElementById('mat-steps')?.value?.trim() || '';
    const body = {};
    if (materializeType)
        body.materializeType = materializeType;
    if (materializeParent)
        body.materializeParent = materializeParent;
    if (steps)
        body.steps = steps;
    try {
        await api('POST', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}/materialize`, body);
        hideModal('materialize-plan-modal');
        toast('Plan materialized — items created. Switching to Items view.', 'success');
        // Navigate to items view so user can see the created items
        setTimeout(() => window.__app?.showView('items'), 1200);
    }
    catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to materialize plan', 'error');
    }
}
export function planEditPrompt(planId, currentTitle) {
    createModal('edit-plan-modal', 'Edit Plan', `
    <div class="form-group">
      <label class="form-label">Title</label>
      <input class="form-input" id="edit-plan-title" type="text" value="${escHtml(currentTitle)}" autofocus>
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <textarea class="form-textarea" id="edit-plan-desc" rows="3" placeholder="Plan description"></textarea>
    </div>`, `<button class="btn btn-primary" onclick="window.__app.submitEditPlan('${escHtml(planId)}')">Save</button>
     <button class="btn btn-ghost" onclick="window.__app.hideModal('edit-plan-modal')">Cancel</button>`);
    showModal('edit-plan-modal');
    // Populate description async after modal shows
    api('GET', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}`).then((data) => {
        const desc = data?.plan?.description || data?.description || '';
        const el = document.getElementById('edit-plan-desc');
        if (el)
            el.value = desc;
    }).catch(() => { });
}
export async function submitEditPlan(planId) {
    if (!state.currentProject)
        return;
    const title = document.getElementById('edit-plan-title')?.value?.trim();
    const description = document.getElementById('edit-plan-desc')?.value?.trim() || '';
    if (!title) {
        toast('Title is required', 'error');
        return;
    }
    try {
        await api('PATCH', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}`, { title, description });
        hideModal('edit-plan-modal');
        toast('Plan updated', 'success');
        await loadPlanList();
        await openPlanDetail(planId);
    }
    catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to update plan', 'error');
    }
}
export function planDeletePrompt(planId) {
    confirmDialog('Delete plan', `Delete plan ${planId} and all its steps? This cannot be undone.`, async () => {
        if (!state.currentProject)
            return;
        try {
            await api('DELETE', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}`, {});
            toast('Plan deleted', 'success');
            currentPlanId = null;
            const detailEl = document.getElementById('plan-detail-panel');
            if (detailEl)
                detailEl.innerHTML = '<div class="empty-state"><div class="empty-state-text">Select a plan to view its steps</div></div>';
            await loadPlanList();
        }
        catch (err) {
            toast(err instanceof Error ? err.message : 'Failed to delete plan', 'error');
        }
    }, true);
}
// Expose currentPlanId for potential external use
export function getCurrentPlanId() { return currentPlanId; }
//# sourceMappingURL=plan.js.map