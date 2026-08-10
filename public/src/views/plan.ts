// ═══════════════════════════════════════════════════════════════
// PLAN VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';
import { showModal, hideModal, createModal, confirmDialog } from '../components/modals.js';
import { buildPlanExecutionSnapshot, buildPlanAgentBrief, buildNextStepPrompt, type AnalyzedPlanStep, type PlanExecutionSnapshot } from './plan-execution.js';
import type { ListResponse, PlanResponse } from '../api-types.js';

// ─── Types ───────────────────────────────────────────────────

type PlanStep = {
  id?: string;
  ref?: string;
  title?: string;
  description?: string;
  status?: string;
  blockedReason?: string;
  blocked_reason?: string;
  dependsOn?: string[];
  depends_on?: string[];
};

type PlanData = {
  id?: string;
  title?: string;
  description?: string;
  scope?: string;
  status?: string;
  tags?: string[];
  priority?: number;
  steps?: PlanStep[];
  approvedAt?: string;
  approved_at?: string;
  createdAt?: string;
  created_at?: string;
};

// ─── State ───────────────────────────────────────────────────

let currentPlanId: string | null = null;
let currentPlanData: PlanData | null = null;
let currentExecutionSnapshot: PlanExecutionSnapshot | null = null;

// ─── Helpers ─────────────────────────────────────────────────

function stepRef(step: PlanStep): string {
  return step.ref || step.id || '';
}

/**
 * Returns a small colored HTML status badge for a plan step, mapping the step
 * status (defaulting to pending) to a fixed color by lowercasing the status
 * text.
 */
function stepStatusBadge(status?: string): string {
  const s = (status || 'pending').toLowerCase();
  const colors: Record<string, string> = {
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

/**
 * Returns an HTML metric badge card showing an uppercase label and a colored
 * value, used for the plan execution summary counts.
 */
function metricBadge(label: string, value: string, color: string): string {
  return `
    <div style="padding:8px 10px;border-radius:8px;background:color-mix(in srgb,${color} 14%, var(--bg-card));border:1px solid color-mix(in srgb,${color} 28%, var(--border));min-width:95px">
      <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px">${escHtml(label)}</div>
      <div style="font-size:14px;font-weight:600;color:${color};margin-top:2px">${escHtml(value)}</div>
    </div>`;
}

/**
 * Returns inline HTML describing a step's dependency state: an empty string
 * when the step has no dependencies, is done, or is blocked; a 'Dependencies
 * complete' note when all are finished; or a 'Waiting on' note listing the
 * incomplete and unresolved (missing) dependencies.
 */
function renderDependencyHint(analyzed?: AnalyzedPlanStep): string {
  if (!analyzed || analyzed.dependsOn.length === 0 || analyzed.isDone || analyzed.isBlocked) return '';

  if (analyzed.incompleteDependencies.length === 0 && analyzed.unresolvedDependencies.length === 0) {
    return `<div style="font-size:12px;color:var(--text-muted);margin-top:3px">Dependencies complete: ${escHtml(analyzed.dependsOn.join(', '))}</div>`;
  }

  const blockers = [
    ...analyzed.incompleteDependencies,
    ...analyzed.unresolvedDependencies.map(dep => `${dep} (missing)`),
  ];
  return `<div style="font-size:12px;color:var(--warning,#f59e0b);margin-top:3px">Waiting on: ${escHtml(blockers.join(', '))}</div>`;
}

/**
 * Renders the Execution Focus card for a plan: a dependency-aware summary with
 * copy buttons for the agent brief and next-step prompt, metric badges for the
 * completed/ready/waiting/blocked counts, the next ready step, and previews of
 * the waiting and blocked steps.
 */
function renderExecutionFocus(planId: string, snapshot: PlanExecutionSnapshot): string {
  const next = snapshot.nextReadyStep;
  const waitingPreview = snapshot.waitingSteps.slice(0, 2).map(step => {
    const blockers = [
      ...step.incompleteDependencies,
      ...step.unresolvedDependencies.map(dep => `${dep} (missing)`),
    ];
    return `
      <li style="font-size:12px;color:var(--text-secondary);line-height:1.5">
        <span style="font-family:'JetBrains Mono',monospace;color:var(--text-muted)">[${escHtml(step.ref)}]</span>
        ${escHtml(step.title)} - waiting on ${escHtml(blockers.join(', '))}
      </li>`;
  }).join('');
  const blockedPreview = snapshot.blockedStepDetails.slice(0, 2).map(step => `
    <li style="font-size:12px;color:var(--text-secondary);line-height:1.5">
      <span style="font-family:'JetBrains Mono',monospace;color:var(--text-muted)">[${escHtml(step.ref)}]</span>
      ${escHtml(step.title)}
      ${step.blockedReason ? `<span style="color:var(--status-blocked)"> - ${escHtml(step.blockedReason)}</span>` : ''}
    </li>`).join('');

  return `
    <div style="margin-bottom:12px;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-elevated)">
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:flex-start">
        <div>
          <div style="font-size:13px;font-weight:600">Execution Focus</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">Dependency-aware summary to guide agent execution.</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick="window.__app.copyPlanAgentBrief('${escHtml(planId)}')" title="Copy dependency and status summary">Copy agent brief</button>
          ${next ? `<button class="btn btn-secondary btn-sm" onclick="window.__app.copyPlanNextStepPrompt('${escHtml(planId)}','${escHtml(next.ref)}')" title="Copy prompt for the next ready step">Copy next-step prompt</button>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        ${metricBadge('Complete', `${snapshot.completedSteps}/${snapshot.totalSteps}`, 'var(--status-closed)')}
        ${metricBadge('Ready', String(snapshot.readySteps.length), 'var(--accent)')}
        ${metricBadge('Waiting', String(snapshot.waitingSteps.length), 'var(--warning,#f59e0b)')}
        ${metricBadge('Blocked', String(snapshot.blockedStepDetails.length), 'var(--status-blocked)')}
      </div>
      ${next
        ? `<div style="margin-top:10px;font-size:12px;color:var(--text-secondary)">Next ready step: <span style="font-family:'JetBrains Mono',monospace;color:var(--text-muted)">[${escHtml(next.ref)}]</span> <strong>${escHtml(next.title)}</strong></div>`
        : '<div style="margin-top:10px;font-size:12px;color:var(--text-muted)">No ready steps right now. Resolve blockers or dependencies to continue.</div>'}
      ${waitingPreview
        ? `<div style="margin-top:8px">
            <div style="font-size:12px;font-weight:600;color:var(--text-secondary)">Waiting queue</div>
            <ul style="margin:6px 0 0 16px;padding:0;display:flex;flex-direction:column;gap:4px">${waitingPreview}</ul>
            ${snapshot.waitingSteps.length > 2 ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">+ ${snapshot.waitingSteps.length - 2} more waiting step(s)</div>` : ''}
          </div>`
        : ''}
      ${blockedPreview
        ? `<div style="margin-top:8px">
            <div style="font-size:12px;font-weight:600;color:var(--status-blocked)">Blocked steps</div>
            <ul style="margin:6px 0 0 16px;padding:0;display:flex;flex-direction:column;gap:4px">${blockedPreview}</ul>
            ${snapshot.blockedStepDetails.length > 2 ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">+ ${snapshot.blockedStepDetails.length - 2} more blocked step(s)</div>` : ''}
          </div>`
        : ''}
    </div>`;
}

/**
 * Returns the HTML for a single plan step row: the step ref, title (struck
 * through when done), status badge, description, dependency hint, and blocked
 * reason, plus conditional action buttons to copy the step prompt, mark
 * complete, block, or remove the step.
 */
function renderStepRow(step: PlanStep, planId: string, analyzed?: AnalyzedPlanStep): string {
  const ref = stepRef(step);
  const isDone = ['done', 'completed'].includes((step.status || '').toLowerCase());
  const isBlocked = (step.status || '').toLowerCase() === 'blocked';
  const isWaiting = !!analyzed && !analyzed.isDone && !analyzed.isBlocked
    && (analyzed.incompleteDependencies.length > 0 || analyzed.unresolvedDependencies.length > 0);
  const promptTitle = isBlocked
    ? 'Copy blocker-resolution prompt'
    : (isWaiting ? 'Copy dependency-resolution prompt' : 'Copy execution prompt');
  const dependencyHint = renderDependencyHint(analyzed);
  return `
    <div class="plan-step-row" data-step-ref="${escHtml(ref)}">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--text-muted);font-family:'JetBrains Mono',monospace">${escHtml(ref)}</span>
          <span style="font-size:13px;font-weight:500;${isDone ? 'text-decoration:line-through;color:var(--text-muted)' : ''}">${escHtml(step.title || '(untitled)')}</span>
          ${stepStatusBadge(step.status)}
        </div>
        ${step.description ? `<div style="font-size:12px;color:var(--text-muted);margin-top:3px">${escHtml(step.description)}</div>` : ''}
        ${dependencyHint}
        ${isBlocked && (step.blockedReason || step.blocked_reason) ? `<div style="font-size:12px;color:var(--status-blocked);margin-top:3px">Blocked: ${escHtml(step.blockedReason || step.blocked_reason || '')}</div>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        ${!isDone ? `<button class="btn btn-ghost btn-sm" onclick="window.__app.copyPlanNextStepPrompt('${escHtml(planId)}','${escHtml(ref)}')" title="${escHtml(promptTitle)}" ${isBlocked ? 'style="color:var(--status-blocked)"' : ''}>⧉</button>` : ''}
        ${!isDone ? `<button class="btn btn-ghost btn-sm" onclick="window.__app.planCompleteStep('${escHtml(planId)}','${escHtml(ref)}')" title="Mark complete">✓</button>` : ''}
        ${!isBlocked && !isDone ? `<button class="btn btn-ghost btn-sm" onclick="window.__app.planBlockStepPrompt('${escHtml(planId)}','${escHtml(ref)}')" title="Block">⊘</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="window.__app.planRemoveStep('${escHtml(planId)}','${escHtml(ref)}')" title="Remove" style="color:var(--danger,#f87171)">✕</button>
      </div>
    </div>`;
}

// ─── Render ──────────────────────────────────────────────────

/**
 * Returns the top-level HTML markup for the Plans view: a page header with New
 * Plan and Refresh buttons and a two-panel layout holding the plan list and
 * detail panels.
 */
export function renderPlanView(): string {
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

/**
 * Initializes the Plans view into the page and resets the currently selected
 * plan state. Shows a no-project empty state and returns when no project is
 * selected; otherwise renders the view and loads the plan list.
 */
export async function initPlanView(): Promise<void> {
  const el = document.getElementById('content-plan');
  if (!el) return;
  currentPlanId = null;
  currentPlanData = null;
  currentExecutionSnapshot = null;
  if (!state.currentProject) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>';
    return;
  }
  el.innerHTML = renderPlanView();
  await loadPlanList();
}

/**
 * Fetches all plans for the current project and renders them as clickable
 * sidebar entries in the plan list panel, updating the subtitle to the project
 * name. Clears the current plan when there are none, and shows an error state
 * if the request fails.
 */
async function loadPlanList(): Promise<void> {
  const listEl = document.getElementById('plan-list-panel');
  const subEl = document.getElementById('plan-subtitle');
  if (!listEl || !state.currentProject) return;

  listEl.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';

  try {
    const data = await api<ListResponse>('GET', `/projects/${state.currentProject.id}/pm/list-all?type=Plan`);
    const items = (data.items || []) as PlanData[];
    if (subEl) subEl.textContent = state.currentProject.name;

    if (items.length === 0) {
      currentPlanId = null;
      currentPlanData = null;
      currentExecutionSnapshot = null;
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
  } catch(err: unknown) {
    listEl.innerHTML = `<div class="empty-state" style="padding:16px"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

/**
 * Loads a plan into the detail panel by id, highlighting it in the list and
 * building a dependency-aware execution snapshot. Renders a card with
 * approve/materialize/edit/delete actions, the description and scope, the
 * execution focus summary, and the list of step rows with an add-step button.
 * Shows an error state if the fetch fails.
 */
export async function openPlanDetail(planId: string): Promise<void> {
  currentPlanId = planId;

  // Highlight selected in list
  document.querySelectorAll('#plan-list-panel [data-plan-id]').forEach(el => {
    (el as HTMLElement).style.background = (el as HTMLElement).dataset.planId === planId ? 'var(--bg-elevated)' : '';
  });

  const detailEl = document.getElementById('plan-detail-panel');
  if (!detailEl || !state.currentProject) return;
  detailEl.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';

  try {
    const data = await api<PlanResponse>('GET', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}`);
    const plan = (data.plan || data) as PlanData;
    const steps = plan.steps || [];
    const snapshot = buildPlanExecutionSnapshot(steps);
    currentPlanData = plan;
    currentExecutionSnapshot = snapshot;

    const isApproved = !!(plan.approvedAt || plan.approved_at);

    const card = document.createElement('div');
    card.className = 'card';

    const header = document.createElement('div');
    header.className = 'card-header';
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.flexWrap = 'wrap';
    header.style.gap = '8px';

    const heading = document.createElement('div');
    const titleEl = document.createElement('div');
    titleEl.className = 'card-title';
    titleEl.textContent = plan.title || planId;
    const idEl = document.createElement('div');
    idEl.style.fontSize = '12px';
    idEl.style.color = 'var(--text-muted)';
    idEl.style.marginTop = '2px';
    idEl.style.fontFamily = "'JetBrains Mono',monospace";
    idEl.textContent = plan.id || planId;
    heading.append(titleEl, idEl);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.flexWrap = 'wrap';

    if (!isApproved) {
      const approveBtn = document.createElement('button');
      approveBtn.className = 'btn btn-secondary btn-sm';
      approveBtn.textContent = '✓ Approve';
      approveBtn.addEventListener('click', () => { void planApprove(planId); });
      actions.appendChild(approveBtn);
    } else {
      const approvedLabel = document.createElement('span');
      approvedLabel.style.fontSize = '12px';
      approvedLabel.style.color = 'var(--status-closed)';
      approvedLabel.textContent = '✓ Approved';
      actions.appendChild(approvedLabel);
    }

    const materializeBtn = document.createElement('button');
    materializeBtn.className = 'btn btn-primary btn-sm';
    materializeBtn.textContent = '⇗ Materialize';
    materializeBtn.addEventListener('click', () => planMaterializePrompt(planId));
    actions.appendChild(materializeBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-ghost btn-sm';
    editBtn.title = 'Edit plan';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', () => planEditPrompt(planId, plan.title || ''));
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-ghost btn-sm';
    deleteBtn.title = 'Delete plan';
    deleteBtn.style.color = 'var(--danger,#f87171)';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', () => planDeletePrompt(planId));
    actions.appendChild(deleteBtn);

    header.append(heading, actions);

    const body = document.createElement('div');
    body.className = 'card-body';

    if (plan.description) {
      const descEl = document.createElement('div');
      descEl.style.fontSize = '13px';
      descEl.style.color = 'var(--text-secondary)';
      descEl.style.marginBottom = '12px';
      descEl.textContent = plan.description;
      body.appendChild(descEl);
    }

    if (plan.scope) {
      const scopeEl = document.createElement('div');
      scopeEl.style.fontSize = '12px';
      scopeEl.style.color = 'var(--text-muted)';
      scopeEl.style.marginBottom = '8px';
      scopeEl.textContent = `Scope: ${plan.scope}`;
      body.appendChild(scopeEl);
    }

    const focusTemplate = document.createElement('template');
    focusTemplate.innerHTML = renderExecutionFocus(planId, snapshot);
    body.appendChild(focusTemplate.content);

    const stepsHeader = document.createElement('div');
    stepsHeader.style.display = 'flex';
    stepsHeader.style.alignItems = 'center';
    stepsHeader.style.justifyContent = 'space-between';
    stepsHeader.style.marginBottom = '8px';

    const stepsTitle = document.createElement('div');
    stepsTitle.style.fontSize = '13px';
    stepsTitle.style.fontWeight = '600';
    stepsTitle.textContent = `Steps (${steps.length})`;

    const addStepBtn = document.createElement('button');
    addStepBtn.className = 'btn btn-ghost btn-sm';
    addStepBtn.textContent = '+ Add Step';
    addStepBtn.addEventListener('click', () => openAddStepModal(planId));

    stepsHeader.append(stepsTitle, addStepBtn);
    body.appendChild(stepsHeader);

    const stepsList = document.createElement('div');
    stepsList.id = 'plan-steps-list';
    if (steps.length === 0) {
      const emptySteps = document.createElement('div');
      emptySteps.style.fontSize = '13px';
      emptySteps.style.color = 'var(--text-muted)';
      emptySteps.style.padding = '8px 0';
      emptySteps.textContent = 'No steps yet. Add the first step to get started.';
      stepsList.appendChild(emptySteps);
    } else {
      steps.forEach((step, index) => {
        const rowTemplate = document.createElement('template');
        rowTemplate.innerHTML = renderStepRow(step, planId, snapshot.allSteps[index]);
        stepsList.appendChild(rowTemplate.content);
      });
    }
    body.appendChild(stepsList);

    card.append(header, body);
    detailEl.replaceChildren(card);
  } catch(err: unknown) {
    currentPlanData = null;
    currentExecutionSnapshot = null;
    detailEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

// ─── Modal builders ──────────────────────────────────────────

/**
 * Opens the New Plan modal with fields for title, description, scope, tags, and
 * priority. Shows an info toast and returns early when no project is currently
 * selected.
 */
export function openCreatePlanModal(): void {
  if (!state.currentProject) { toast('Select a project first', 'info'); return; }
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
    </div>`,
    `<button class="btn btn-primary" onclick="window.__app.submitCreatePlan()">Create Plan</button>
     <button class="btn btn-ghost" onclick="window.__app.hideModal('create-plan-modal')">Cancel</button>`);
  showModal('create-plan-modal');
}

/**
 * Submits the New Plan form, requiring a title, and posts the plan fields to
 * the plan endpoint. On success it closes the modal, toasts confirmation, and
 * reloads the plan list.
 */
export async function submitCreatePlan(): Promise<void> {
  if (!state.currentProject) return;
  const title = (document.getElementById('plan-title') as HTMLInputElement | null)?.value?.trim();
  if (!title) { toast('Title is required', 'error'); return; }

  const description = (document.getElementById('plan-desc') as HTMLTextAreaElement | null)?.value?.trim() || '';
  const scope = (document.getElementById('plan-scope') as HTMLInputElement | null)?.value?.trim() || '';
  const tags = (document.getElementById('plan-tags') as HTMLInputElement | null)?.value?.trim() || '';
  const priority = (document.getElementById('plan-priority') as HTMLSelectElement | null)?.value || '';

  const body: Record<string, string> = { title };
  if (description) body.description = description;
  if (scope) body.scope = scope;
  if (tags) body.tags = tags;
  if (priority) body.priority = priority;

  try {
    await api('POST', `/projects/${state.currentProject.id}/pm/plan`, body);
    hideModal('create-plan-modal');
    toast('Plan created', 'success');
    await loadPlanList();
  } catch(err: unknown) {
    toast(err instanceof Error ? err.message : 'Failed to create plan', 'error');
  }
}

/**
 * Opens the Add Step modal for the given plan with title, description, and
 * depends-on fields, wiring its submit button to submitAddStep with the plan
 * id.
 */
export function openAddStepModal(planId: string): void {
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
    </div>`,
    `<button class="btn btn-primary" onclick="window.__app.submitAddStep('${escHtml(planId)}')">Add Step</button>
     <button class="btn btn-ghost" onclick="window.__app.hideModal('add-step-modal')">Cancel</button>`);
  showModal('add-step-modal');
}

/**
 * Submits the Add Step form for a plan, requiring a title, and posts the step
 * fields to the plan's steps endpoint. On success it closes the modal, toasts
 * confirmation, and reopens the plan detail to show the new step.
 */
export async function submitAddStep(planId: string): Promise<void> {
  if (!state.currentProject) return;
  const title = (document.getElementById('step-title') as HTMLInputElement | null)?.value?.trim();
  if (!title) { toast('Title is required', 'error'); return; }

  const description = (document.getElementById('step-desc') as HTMLTextAreaElement | null)?.value?.trim() || '';
  const dependsOn = (document.getElementById('step-depends') as HTMLInputElement | null)?.value?.trim() || '';

  const body: Record<string, string> = { title };
  if (description) body.description = description;
  if (dependsOn) body.dependsOn = dependsOn;

  try {
    await api('POST', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}/steps`, body);
    hideModal('add-step-modal');
    toast('Step added', 'success');
    await openPlanDetail(planId);
  } catch(err: unknown) {
    toast(err instanceof Error ? err.message : 'Failed to add step', 'error');
  }
}

/**
 * Marks the given plan step complete by posting to the step's complete
 * endpoint, then toasts confirmation and reopens the plan detail.
 */
export async function planCompleteStep(planId: string, stepRef: string): Promise<void> {
  if (!state.currentProject) return;
  try {
    await api('POST', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepRef)}/complete`, {});
    toast('Step completed', 'success');
    await openPlanDetail(planId);
  } catch(err: unknown) {
    toast(err instanceof Error ? err.message : 'Failed to complete step', 'error');
  }
}

/**
 * Opens the Block Step modal for the given plan step, collecting a required
 * reason and wiring its submit button to submitBlockStep with the plan id and
 * step ref.
 */
export function planBlockStepPrompt(planId: string, stepRef: string): void {
  createModal('block-step-modal', 'Block Step', `
    <div class="form-group">
      <label class="form-label">Reason *</label>
      <input class="form-input" id="block-reason" type="text" placeholder="Why is this step blocked?" autofocus required>
    </div>`,
    `<button class="btn btn-primary" onclick="window.__app.submitBlockStep('${escHtml(planId)}','${escHtml(stepRef)}')">Block Step</button>
     <button class="btn btn-ghost" onclick="window.__app.hideModal('block-step-modal')">Cancel</button>`);
  showModal('block-step-modal');
}

/**
 * Submits the Block Step form, requiring a reason, and posts it to the step's
 * block endpoint. On success it closes the modal, toasts confirmation, and
 * reopens the plan detail.
 */
export async function submitBlockStep(planId: string, stepRef: string): Promise<void> {
  if (!state.currentProject) return;
  const reason = (document.getElementById('block-reason') as HTMLInputElement | null)?.value?.trim();
  if (!reason) { toast('Reason is required', 'error'); return; }

  try {
    await api('POST', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepRef)}/block`, { reason });
    hideModal('block-step-modal');
    toast('Step blocked', 'success');
    await openPlanDetail(planId);
  } catch(err: unknown) {
    toast(err instanceof Error ? err.message : 'Failed to block step', 'error');
  }
}

/**
 * Removes a plan step after confirming with the user, DELETEing it from the
 * plan's steps endpoint. On success it toasts confirmation and reopens the plan
 * detail.
 */
export function planRemoveStep(planId: string, stepRef: string): void {
  confirmDialog(
    'Remove step',
    `Remove step ${stepRef} from plan?`,
    async () => {
      if (!state.currentProject) return;
      try {
        await api('DELETE', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepRef)}`, {});
        toast('Step removed', 'success');
        await openPlanDetail(planId);
      } catch(err: unknown) {
        toast(err instanceof Error ? err.message : 'Failed to remove step', 'error');
      }
    },
    true
  );
}

/**
 * Approves a plan after confirming with the user by posting to the plan's
 * approve endpoint, then toasts confirmation and reopens the plan detail.
 */
export function planApprove(planId: string): void {
  confirmDialog(
    'Approve plan',
    `Approve plan ${planId}? Once approved, it can be materialized.`,
    async () => {
      if (!state.currentProject) return;
      try {
        await api('POST', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}/approve`, {});
        toast('Plan approved', 'success');
        await openPlanDetail(planId);
      } catch(err: unknown) {
        toast(err instanceof Error ? err.message : 'Failed to approve plan', 'error');
      }
    }
  );
}

/**
 * Opens the Materialize Plan modal for the given plan, offering fields for item
 * type, a parent item id, and which steps to materialize, wiring its submit
 * button to submitMaterializePlan with the plan id.
 */
export function planMaterializePrompt(planId: string): void {
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
    </div>`,
    `<button class="btn btn-primary" onclick="window.__app.submitMaterializePlan('${escHtml(planId)}')">Materialize</button>
     <button class="btn btn-ghost" onclick="window.__app.hideModal('materialize-plan-modal')">Cancel</button>`);
  showModal('materialize-plan-modal');
}

/**
 * Submits the Materialize Plan form, posting the chosen item type, parent item,
 * and steps to the plan's materialize endpoint to create real items. On success
 * it closes the modal, toasts confirmation, and switches to the Items view
 * after a short delay.
 */
export async function submitMaterializePlan(planId: string): Promise<void> {
  if (!state.currentProject) return;
  const materializeType = (document.getElementById('mat-type') as HTMLSelectElement | null)?.value || '';
  const materializeParent = (document.getElementById('mat-parent') as HTMLInputElement | null)?.value?.trim() || '';
  const steps = (document.getElementById('mat-steps') as HTMLInputElement | null)?.value?.trim() || '';

  const body: Record<string, string> = {};
  if (materializeType) body.materializeType = materializeType;
  if (materializeParent) body.materializeParent = materializeParent;
  if (steps) body.steps = steps;

  try {
    await api('POST', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}/materialize`, body);
    hideModal('materialize-plan-modal');
    toast('Plan materialized — items created. Switching to Items view.', 'success');
    // Navigate to items view so user can see the created items
    setTimeout(() => window.__app?.showView('items'), 1200);
  } catch(err: unknown) {
    toast(err instanceof Error ? err.message : 'Failed to materialize plan', 'error');
  }
}

/**
 * Copies text to the clipboard and toasts the success message when the
 * Clipboard API is available. When clipboard access is unavailable or blocked,
 * opens a modal with a prefilled, selected textarea for manual copy and toasts
 * an info notice instead.
 */
async function copyTextWithFallback(modalTitle: string, text: string, successMessage: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      toast(successMessage, 'success');
      return;
    } catch {
    // Fall through to manual-copy modal.
    }
  }

  const modalId = 'plan-copy-fallback-modal';
  createModal(modalId, modalTitle, `
    <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Clipboard access is unavailable in this browser context. Copy manually:</p>
    <textarea class="form-textarea" id="plan-copy-fallback-text" rows="12" spellcheck="false"></textarea>`,
  `<button class="btn btn-primary" onclick="window.__app.hideModal('${modalId}')">Close</button>`);
  showModal(modalId);
  const el = document.getElementById('plan-copy-fallback-text') as HTMLTextAreaElement | null;
  if (el) {
    el.value = text;
    el.focus();
    el.select();
  }
  toast('Clipboard blocked. Opened manual copy panel.', 'info');
}

/**
 * Returns the currently open plan and its execution snapshot when the requested
 * plan id matches the active plan; otherwise toasts an info notice and returns
 * null so prompt generators bail out.
 */
function getCurrentPlanContext(planId: string): { plan: PlanData; snapshot: PlanExecutionSnapshot } | null {
  const activeId = currentPlanData?.id || currentPlanId;
  if (!currentPlanData || !currentExecutionSnapshot || activeId !== planId) {
    toast('Open this plan first to generate prompts', 'info');
    return null;
  }
  return { plan: currentPlanData, snapshot: currentExecutionSnapshot };
}

/**
 * Builds the dependency-aware agent brief for the currently open plan and
 * copies it via copyTextWithFallback, first confirming the plan is open using
 * its id.
 */
export async function copyPlanAgentBrief(planId: string): Promise<void> {
  const ctx = getCurrentPlanContext(planId);
  if (!ctx) return;
  const brief = buildPlanAgentBrief(ctx.plan, ctx.snapshot);
  await copyTextWithFallback('Plan Agent Brief', brief, 'Agent brief copied');
}

/**
 * Builds and copies an execution prompt for a specific plan step, or for the
 * next ready step when no ref is given. Validates that the requested step
 * exists (or that a ready step exists), then copies the prompt via
 * copyTextWithFallback.
 */
export async function copyPlanNextStepPrompt(planId: string, stepRef?: string): Promise<void> {
  const ctx = getCurrentPlanContext(planId);
  if (!ctx) return;

  if (stepRef && !ctx.snapshot.stepByRef[stepRef]) {
    toast(`Step ${stepRef} not found`, 'error');
    return;
  }
  if (!stepRef && !ctx.snapshot.nextReadyStep) {
    toast('No ready step available right now', 'info');
    return;
  }

  const prompt = buildNextStepPrompt(ctx.plan, ctx.snapshot, stepRef);
  await copyTextWithFallback('Next Step Prompt', prompt, 'Next-step prompt copied');
}

/**
 * Opens the Edit Plan modal with the title pre-filled, asynchronously
 * populates the description by re-fetching the plan, and wires the submit
 * button to submitEditPlan with the plan id.
 */
export function planEditPrompt(planId: string, currentTitle: string): void {
  createModal('edit-plan-modal', 'Edit Plan', `
    <div class="form-group">
      <label class="form-label">Title</label>
      <input class="form-input" id="edit-plan-title" type="text" value="${escHtml(currentTitle)}" autofocus>
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <textarea class="form-textarea" id="edit-plan-desc" rows="3" placeholder="Plan description"></textarea>
    </div>`,
    `<button class="btn btn-primary" onclick="window.__app.submitEditPlan('${escHtml(planId)}')">Save</button>
     <button class="btn btn-ghost" onclick="window.__app.hideModal('edit-plan-modal')">Cancel</button>`);
  showModal('edit-plan-modal');
  // Populate description async after modal shows
  api<PlanResponse>('GET', `/projects/${state.currentProject!.id}/pm/plan/${encodeURIComponent(planId)}`).then((data) => {
    const desc = data?.plan?.description || data?.description || '';
    const el = document.getElementById('edit-plan-desc') as HTMLTextAreaElement | null;
    if (el) el.value = desc;
  }).catch(() => {});
}

/**
 * Submits the Edit Plan form, requiring a title, and PATCHes the title and
 * description to the plan endpoint. On success it closes the modal, toasts
 * confirmation, and reloads both the plan list and the plan detail.
 */
export async function submitEditPlan(planId: string): Promise<void> {
  if (!state.currentProject) return;
  const title = (document.getElementById('edit-plan-title') as HTMLInputElement | null)?.value?.trim();
  const description = (document.getElementById('edit-plan-desc') as HTMLTextAreaElement | null)?.value?.trim() || '';
  if (!title) { toast('Title is required', 'error'); return; }
  try {
    await api('PATCH', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}`, { title, description });
    hideModal('edit-plan-modal');
    toast('Plan updated', 'success');
    await loadPlanList();
    await openPlanDetail(planId);
  } catch(err: unknown) {
    toast(err instanceof Error ? err.message : 'Failed to update plan', 'error');
  }
}

/**
 * Deletes a plan after confirming with the user by DELETEing it from the plan
 * endpoint. On success it toasts confirmation, clears the active plan state and
 * detail panel, and reloads the plan list.
 */
export function planDeletePrompt(planId: string): void {
  confirmDialog(
    'Delete plan',
    `Delete plan ${planId} and all its steps? This cannot be undone.`,
    async () => {
      if (!state.currentProject) return;
      try {
        await api('DELETE', `/projects/${state.currentProject.id}/pm/plan/${encodeURIComponent(planId)}`, {});
        toast('Plan deleted', 'success');
        currentPlanId = null;
        currentPlanData = null;
        currentExecutionSnapshot = null;
        const detailEl = document.getElementById('plan-detail-panel');
        if (detailEl) detailEl.innerHTML = '<div class="empty-state"><div class="empty-state-text">Select a plan to view its steps</div></div>';
        await loadPlanList();
      } catch(err: unknown) {
        toast(err instanceof Error ? err.message : 'Failed to delete plan', 'error');
      }
    },
    true
  );
}

// Expose currentPlanId for potential external use
/**
 * Returns the id of the currently selected plan, or null when no plan is
 * selected.
 */
export function getCurrentPlanId(): string | null { return currentPlanId; }
