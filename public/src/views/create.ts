// ═══════════════════════════════════════════════════════════════
// CREATE ITEM VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { toast } from '../components/toast.js';
import { TYPES, TYPE_ICONS, PRIORITY_LABELS } from '../constants.js';
import { showView } from './router.js';
import { loadItemsBadge } from './projects.js';
import { openItemDetail } from './items.js';

export function renderCreateView(): void {
  const el = document.getElementById('content-create');
  if (!el) return;
  if (!state.currentProject) { el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>'; return; }
  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Create Item</div><div class="page-subtitle">Add a new item to ${escHtml(state.currentProject.name)}</div></div>
    </div>
    <div class="card" style="max-width:620px">
      <div class="card-body">
        <form id="create-item-form" onsubmit="window.__app.submitCreateItem(event)">
          <div class="form-group">
            <label class="form-label">Title *</label>
            <input class="form-input" id="ci-title" type="text" placeholder="Brief description of the item" required autofocus>
          </div>
          <div class="two-col">
            <div class="form-group">
              <label class="form-label">Type</label>
              <select class="form-select" id="ci-type">
                ${TYPES.map(t=>`<option value="${t}"${t==='Task'?' selected':''}>${TYPE_ICONS[t]||''} ${t}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Priority</label>
              <select class="form-select" id="ci-priority">
                ${[1,2,3,4,5].map(p=>`<option value="${p}"${p===3?' selected':''}>P${p}: ${PRIORITY_LABELS[p]}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Description</label>
            <textarea class="form-textarea" id="ci-desc" placeholder="Detailed description (optional)" rows="5"></textarea>
          </div>
          <div class="two-col">
            <div class="form-group">
              <label class="form-label">Tags</label>
              <input class="form-input" id="ci-tags" type="text" placeholder="comma, separated, tags">
            </div>
            <div class="form-group">
              <label class="form-label">Parent Item ID</label>
              <input class="form-input" id="ci-parent" type="text" placeholder="${escHtml(state.currentProject.prefix)}-1">
            </div>
          </div>
          <div class="two-col">
            <div class="form-group">
              <label class="form-label">Deadline</label>
              <input class="form-input" id="ci-deadline" type="text" placeholder="+1d, +1w, 2026-06-01">
            </div>
            <div class="form-group">
              <label class="form-label">Assignee</label>
              <input class="form-input" id="ci-assignee" type="text" placeholder="username or email">
            </div>
          </div>
          <div class="two-col">
            <div class="form-group">
              <label class="form-label">Sprint</label>
              <input class="form-input" id="ci-sprint" type="text" placeholder="sprint-1">
            </div>
            <div class="form-group">
              <label class="form-label">Release</label>
              <input class="form-input" id="ci-release" type="text" placeholder="v1.0.0">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Estimated Minutes</label>
            <input class="form-input" id="ci-estimate" type="number" min="1" placeholder="e.g. 60">
          </div>
          <div class="form-group">
            <label class="form-label">Acceptance Criteria</label>
            <textarea class="form-textarea" id="ci-acceptance-criteria" placeholder="What conditions must be met?" rows="2"></textarea>
          </div>
          <details style="margin-top:8px;margin-bottom:4px">
            <summary style="cursor:pointer;color:var(--text-secondary);font-size:13px;padding:4px 0;user-select:none">▸ Advanced fields</summary>
            <div style="margin-top:12px;display:flex;flex-direction:column;gap:0">
              <div class="form-group">
                <label class="form-label">Body (Markdown)</label>
                <textarea class="form-textarea" id="ci-body" placeholder="Full body / notes in markdown" rows="3"></textarea>
              </div>
              <div class="two-col">
                <div class="form-group">
                  <label class="form-label">Reporter</label>
                  <input class="form-input" id="ci-reporter" type="text" placeholder="who reported this">
                </div>
                <div class="form-group">
                  <label class="form-label">Component</label>
                  <input class="form-input" id="ci-component" type="text" placeholder="e.g. auth, api, ui">
                </div>
              </div>
              <div class="two-col">
                <div class="form-group">
                  <label class="form-label">Severity</label>
                  <select class="form-select" id="ci-severity">
                    <option value="">— none —</option>
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
                <div class="form-group">
                  <label class="form-label">Risk</label>
                  <select class="form-select" id="ci-risk">
                    <option value="">— none —</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">Goal / Objective</label>
                <input class="form-input" id="ci-goal" type="text" placeholder="What business goal does this serve?">
              </div>
              <div class="two-col">
                <div class="form-group">
                  <label class="form-label">Environment</label>
                  <input class="form-input" id="ci-environment" type="text" placeholder="e.g. production, staging">
                </div>
                <div class="form-group">
                  <label class="form-label">Blocked By</label>
                  <input class="form-input" id="ci-blocked-by" type="text" placeholder="item ID blocking this">
                </div>
              </div>
              <div class="two-col">
                <div class="form-group">
                  <label class="form-label">Repro Steps</label>
                  <textarea class="form-textarea" id="ci-repro-steps" placeholder="Steps to reproduce" rows="2"></textarea>
                </div>
                <div class="form-group">
                  <label class="form-label">Expected Result</label>
                  <textarea class="form-textarea" id="ci-expected-result" placeholder="What should happen" rows="2"></textarea>
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">Blocked Reason</label>
                <textarea class="form-textarea" id="ci-blocked-reason" placeholder="Why is this item blocked? (optional)" rows="2"></textarea>
              </div>
            </div>
          </details>
          <div class="form-error" id="ci-error" style="display:none"></div>
          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
            <button type="submit" class="btn btn-primary" id="ci-submit"><span>Create Item</span></button>
            <button type="button" class="btn btn-secondary" id="ci-submit-open" onclick="window.__app.submitCreateItemAndOpen(event)"><span>Create &amp; Open</span></button>
            <button type="button" class="btn btn-ghost" onclick="window.__app.showView('items')">Cancel</button>
          </div>
        </form>
      </div>
    </div>`;
}

export async function submitCreateItemAndOpen(e: Event): Promise<void> {
  e.preventDefault();
  await submitCreateItem(e, true);
}

export async function submitCreateItem(e: Event, openAfter = false): Promise<void> {
  e.preventDefault();
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value?.trim() || '';
  const title = val('ci-title');
  const type = val('ci-type');
  const priority = val('ci-priority');
  const description = val('ci-desc');
  const tags = val('ci-tags');
  const parent = val('ci-parent');
  const deadline = val('ci-deadline');
  const assignee = val('ci-assignee');
  const sprint = val('ci-sprint');
  const release = val('ci-release');
  const estimate = val('ci-estimate');
  const acceptanceCriteria = val('ci-acceptance-criteria');
  const body = val('ci-body');
  const reporter = val('ci-reporter');
  const component = val('ci-component');
  const severity = val('ci-severity');
  const risk = val('ci-risk');
  const goal = val('ci-goal');
  const environment = val('ci-environment');
  const blockedBy = val('ci-blocked-by');
  const reproSteps = val('ci-repro-steps');
  const expectedResult = val('ci-expected-result');
  const blockedReason = val('ci-blocked-reason');
  const errEl = document.getElementById('ci-error') as HTMLElement | null;
  const btn = document.getElementById('ci-submit') as HTMLButtonElement | null;
  if (errEl) errEl.style.display = 'none';

  if (!title) { if (errEl) { errEl.textContent = 'Title is required'; errEl.style.display='block'; } return; }

  const btnOpen = document.getElementById('ci-submit-open') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; const sp = btn.querySelector('span'); if (sp) sp.textContent = 'Creating…'; }
  if (btnOpen) btnOpen.disabled = true;
  try {
    const bodyData: Record<string, string> = {title,type,priority};
    if (description) bodyData.description = description;
    if (tags) bodyData.tags = tags;
    if (parent) bodyData.parent = parent;
    if (deadline) bodyData.deadline = deadline;
    if (assignee) bodyData.assignee = assignee;
    if (sprint) bodyData.sprint = sprint;
    if (release) bodyData.release = release;
    if (estimate) bodyData.estimate = estimate;
    if (acceptanceCriteria) bodyData.acceptanceCriteria = acceptanceCriteria;
    if (body) bodyData.body = body;
    if (reporter) bodyData.reporter = reporter;
    if (component) bodyData.component = component;
    if (severity) bodyData.severity = severity;
    if (risk) bodyData.risk = risk;
    if (goal) bodyData.goal = goal;
    if (environment) bodyData.environment = environment;
    if (blockedBy) bodyData['blocked-by'] = blockedBy;
    if (reproSteps) bodyData['repro-steps'] = reproSteps;
    if (expectedResult) bodyData['expected-result'] = expectedResult;
    if (blockedReason) bodyData['blocked-reason'] = blockedReason;
    const data = await api('POST',`/projects/${state.currentProject!.id}/pm/create`,bodyData);
    const newId: string = (data as any).item?.id || (data as any).id || '';
    toast(`Created ${newId || 'item'}!`,'success');
    const form = document.getElementById('create-item-form') as HTMLFormElement | null;
    if (form) form.reset();
    const typeEl = document.getElementById('ci-type') as HTMLSelectElement | null;
    if (typeEl) typeEl.value = 'Task';
    const priEl = document.getElementById('ci-priority') as HTMLSelectElement | null;
    if (priEl) priEl.value = '3';
    loadItemsBadge();
    if (openAfter && newId) {
      showView('items');
      openItemDetail(newId);
    } else {
      showView('items');
    }
  } catch(err: unknown) {
    if (errEl) { errEl.textContent = err instanceof Error ? err.message : String(err); errEl.style.display = 'block'; }
    if (btn) { btn.disabled = false; const sp = btn.querySelector('span'); if (sp) sp.textContent = 'Create Item'; }
    if (btnOpen) btnOpen.disabled = false;
  }
}
