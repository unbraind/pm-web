import { state } from '../state.js';
import { api, ApiError } from '../api.js';
import { escHtml } from '../utils.js';

/** Bounded transport projection of a core plan decision request. */
interface InboxRequest {
  planId: string; id: string; revision: string; question: string; alternatives: string[];
  evidence: string; author: string; createdAt: string; acknowledgments: number;
}
interface InboxPage { requests: InboxRequest[]; total: number; nextOffset: number | null }
let renderGeneration = 0;

/** Render a pending decision as a comparison sheet with explicit acknowledgment semantics. */
function requestCard(request: InboxRequest, index: number, editable: boolean): string {
  return `<article class="card decision-request" data-request="${index}">
    <div class="card-header"><span class="card-title">${escHtml(request.question)}</span></div>
    <div class="card-body">
      <p class="decision-meta">${escHtml(request.planId)} · Requested by ${escHtml(request.author)} · ${escHtml(request.createdAt)} · ${request.acknowledgments} acknowledged</p>
      <details open><summary>Evidence</summary><p class="decision-evidence">${escHtml(request.evidence)}</p></details>
      <form data-response="${index}">
        <fieldset ${editable ? '' : 'disabled'}><legend>Choose an alternative</legend>
          ${request.alternatives.map((option, choice) => `<label class="decision-alternative"><input type="radio" name="alternative" value="${choice}" required> <span>${escHtml(option)}</span></label>`).join('')}
        </fieldset>
        <label class="decision-reason">Reason<textarea name="reason" class="form-input" required maxlength="2000" ${editable ? '' : 'disabled'}></textarea></label>
        <div class="page-actions"><button class="btn btn-primary" type="submit" ${editable ? '' : 'disabled'}>Approve alternative</button>
        <button class="btn btn-secondary" type="button" data-ack="${index}" ${editable ? '' : 'disabled'}>Acknowledge only</button></div>
        <p role="status" class="decision-result"></p>
      </form>
    </div></article>`;
}

/** Fetch a bounded inbox page and bind revision-bound responses to its exact project and evidence. */
export async function renderDecisionInbox(offset = 0): Promise<void> {
  const el = document.getElementById('content-decision-inbox');
  if (!el) return;
  const project = state.currentProject;
  const generation = ++renderGeneration;
  if (!project) { el.textContent = 'Select a project to view pending decisions.'; return; }
  const editable = project.permission === 'edit';
  el.innerHTML = `<div class="page-header"><div><h1 class="page-title">Decision inbox</h1><p class="page-subtitle">Compare evidence, choose an alternative, and return a decision to the plan.</p></div><button class="btn btn-secondary" data-refresh>Refresh</button></div>
    <p class="decision-boundary">Acknowledgment keeps the request pending. Decisions do not count as code review or task completion.</p>
    ${editable ? '' : '<p class="decision-boundary">View-only access. Ask a project editor to respond or request edit access.</p>'}
    <p data-inbox-status role="status">Loading decisions…</p>
    <div data-inbox-results aria-busy="true"></div>`;
  el.querySelector('[data-refresh]')?.addEventListener('click', () => { void renderDecisionInbox(); });
  const results = el.querySelector<HTMLElement>('[data-inbox-results]')!;
  const status = el.querySelector<HTMLElement>('[data-inbox-status]')!;
  try {
    const page = await api<InboxPage>('GET', `/projects/${project.id}/pm/decision-inbox?limit=20&offset=${offset}`);
    if (generation !== renderGeneration || state.currentProject?.id !== project.id) return;
    results.innerHTML = `${page.requests.length ? page.requests.map((request, index) => requestCard(request, index, editable)).join('') : '<div class="empty-state"><div class="empty-state-text">No pending decisions. Agents can request a decision on an existing plan with pm web inbox request.</div></div>'}
      ${offset > 0 ? '<button class="btn btn-secondary" data-first>First page</button>' : ''}${page.nextOffset !== null ? '<button class="btn btn-secondary" data-next>Next decisions</button>' : ''}`;
    results.querySelector('[data-first]')?.addEventListener('click', () => { void renderDecisionInbox(); });
    results.querySelector('[data-next]')?.addEventListener('click', () => { void renderDecisionInbox(page.nextOffset!); });
    for (const form of results.querySelectorAll<HTMLFormElement>('form[data-response]')) {
      const request = page.requests[Number(form.dataset.response)];
      form.addEventListener('submit', event => { event.preventDefault(); void respond(form, request, project.id, 'approve'); });
      form.querySelector('[data-ack]')?.addEventListener('click', () => { void respond(form, request, project.id, 'acknowledge'); });
    }
    results.setAttribute('aria-busy', 'false');
    status.textContent = `${page.total} pending decision${page.total === 1 ? '' : 's'}`;
  } catch (error) {
    if (generation === renderGeneration && state.currentProject?.id === project.id) {
      results.setAttribute('aria-busy', 'false');
      status.textContent = `Could not load decisions. ${error instanceof Error ? error.message : 'Refresh to retry.'}`;
    }
  }
}

/** Send one response with the displayed revision; retain reasoning on conflicts and require a fresh explicit choice. */
async function respond(form: HTMLFormElement, request: InboxRequest, projectId: string, action: 'approve' | 'acknowledge'): Promise<void> {
  if (state.currentProject?.id !== projectId || state.currentProject.permission !== 'edit') return;
  const data = new FormData(form);
  const reason = String(data.get('reason') ?? '').trim();
  const result = form.querySelector<HTMLElement>('.decision-result')!;
  if (!reason) { result.textContent = 'Add a reason before responding.'; return; }
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    await api('POST', `/projects/${projectId}/pm/decision-inbox/responses`, { planId: request.planId, requestId: request.id, revision: request.revision, action, reason, ...(action === 'approve' ? { alternative: Number(data.get('alternative')) } : {}) });
    result.textContent = action === 'approve' ? 'Alternative approved and recorded in the plan. Review and task completion remain separate.' : 'Acknowledged. The request remains pending. Refresh before responding again.';
  } catch (error) {
    const payload = error instanceof ApiError ? error.response as { remedy?: string } : undefined;
    result.textContent = `${error instanceof Error ? error.message : 'Response failed.'} ${payload?.remedy ?? 'Refresh and inspect the latest evidence before trying again.'}`;
    buttons.forEach(button => { button.disabled = false; });
  }
}

/** Preserve unsent reasoning when collaboration events arrive; invite an explicit refresh instead. */
export function refreshDecisionInbox(): void {
  const el = document.getElementById('content-decision-inbox');
  if (el && [...el.querySelectorAll('textarea')].some(input => input.value.trim())) {
    const subtitle = el.querySelector('.page-subtitle');
    if (subtitle) subtitle.textContent = 'New activity is available. Refresh to inspect it; copy your unsent reason first.';
    return;
  }
  void renderDecisionInbox();
}
