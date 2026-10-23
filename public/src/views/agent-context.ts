import { state } from '../state.js';
import { api, ApiError } from '../api.js';
import { escHtml } from '../utils.js';
import type { AgentContextPacket } from '../api-types.js';
let generation = 0;
/** Maximum active-view interval between fresh authorization reads, even when SSE is disconnected. */
export const AGENT_CONTEXT_REVALIDATE_MS = 10_000;
interface AccessBinding { projectId: string; id: string; revision: string; offset: number; generation: number }
let binding: AccessBinding | undefined;
let validationTimer: ReturnType<typeof setTimeout> | undefined;
let validationController: AbortController | undefined;
let validationEpoch = 0;

/** Cancel stale timers and reads whenever navigation, account identity or packet selection changes. */
export function stopAgentContextValidation(): void {
  generation++; validationEpoch++;
  if (validationTimer !== undefined) clearTimeout(validationTimer);
  validationController?.abort(); validationController = undefined; validationTimer = undefined; binding = undefined;
}

/** A late network response may never restore a packet after access invalidation or navigation. */
function currentBinding(candidate: AccessBinding): boolean {
  return binding === candidate && generation === candidate.generation && state.currentView === 'agent-context' && state.currentProject?.id === candidate.projectId && !!state.user && !document.hidden;
}

/** Remove confidential DOM immediately, retaining only a public status and the ability to refresh access. */
function clearPacket(message: string): void {
  const el = document.getElementById('content-agent-context');
  el?.querySelector('[data-packet]')?.replaceChildren();
  const status = el?.querySelector<HTMLElement>('[data-status]');
  if (status) status.textContent = message;
}

/** Terminal SSE revocation has no packet payload and cannot be reversed by an older in-flight read. */
export function revokeAgentContextView(projectId: string): void {
  if (state.currentProject?.id !== projectId || state.currentView !== 'agent-context') return;
  stopAgentContextValidation();
  clearPacket('Access revoked. This packet is no longer available to your account.');
  const select = document.querySelector<HTMLSelectElement>('#content-agent-context [data-scope]');
  select?.replaceChildren(); select?.setAttribute('disabled', '');
}

/** Keep exactly one bounded fallback read scheduled for the currently displayed scope. */
function scheduleValidation(candidate: AccessBinding): void {
  if (currentBinding(candidate)) validationTimer = setTimeout(() => { void validatePacketAccess(candidate); }, AGENT_CONTEXT_REVALIDATE_MS);
}

/** Recheck current project membership, packet consent and exact revision with a five-second network deadline. */
async function validatePacketAccess(candidate: AccessBinding): Promise<void> {
  if (!currentBinding(candidate)) return;
  const epoch = ++validationEpoch;
  const controller = new AbortController(); validationController?.abort(); validationController = controller;
  const deadline = setTimeout(() => controller.abort(), 5000);
  try {
    await api<AgentContextPacket>('GET', `/projects/${candidate.projectId}/pm/agent-context/${candidate.id}?revision=${encodeURIComponent(candidate.revision)}`, undefined, controller.signal);
    if (!currentBinding(candidate) || epoch !== validationEpoch) return;
    if (!document.querySelector('#content-agent-context .agent-context-sheet')) { await renderAgentContext(candidate.id, candidate.offset); return; }
    scheduleValidation(candidate);
  } catch (error) {
    if (!currentBinding(candidate) || epoch !== validationEpoch) return;
    const code = error instanceof ApiError ? (error.response as { code?: string }).code : undefined;
    if (code === 'not_found' || code === 'view_only') { revokeAgentContextView(candidate.projectId); return; }
    if (code === 'revision_conflict') { clearPacket('Checking current consent…'); await renderAgentContext(candidate.id, candidate.offset); return; }
    clearPacket('Access could not be verified. Reconnect or refresh before viewing this packet.');
    scheduleValidation(candidate);
  } finally { clearTimeout(deadline); }
}

/** Realtime signals disclose no packet identity; clear first and authorize again before restoring any content. */
export function invalidateAgentContext(projectId: string): void {
  const candidate = binding;
  if (!candidate) {
    if (state.currentProject?.id === projectId && state.currentView === 'agent-context') {
      const selected = document.querySelector<HTMLSelectElement>('#content-agent-context [data-scope]')?.value;
      void renderAgentContext(selected || undefined);
    }
    return;
  }
  if (candidate.projectId !== projectId || !currentBinding(candidate)) return;
  if (validationTimer !== undefined) clearTimeout(validationTimer);
  clearPacket('Checking current consent…');
  void validatePacketAccess(candidate);
}

// Background tabs cannot retain an unbounded visible lease while browser timers are throttled.
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (!binding) return;
  if (document.hidden) { validationEpoch++; if (validationTimer !== undefined) clearTimeout(validationTimer); validationController?.abort(); clearPacket('Checking access before this packet is shown again.'); }
  else invalidateAgentContext(binding.projectId);
});

/** Preserve every omission reason and remedy verbatim, escaped as text rather than interpreted markup. */
function issues(rows: AgentContextPacket['gaps'], empty: string): string {
  return rows.length ? `<ul class="agent-context-issues">${rows.map(row => `<li><strong>${escHtml(row.reason)}</strong><p>${escHtml(row.remedy)}</p></li>`).join('')}</ul>` : `<p>${empty}</p>`;
}

/** Render one revision as a receipt sheet using the existing Triplicate typography and stamp tokens. */
export function agentContextMarkup(packet: AgentContextPacket): string {
  return `<article class="card agent-context-sheet"><div class="card-body">
    <p class="agent-context-label">Current question · ${escHtml(packet.agent)}</p><h2>${escHtml(packet.question)}</h2>
    <p class="agent-context-binding">Revision ${escHtml(packet.revision)}<br>Updated ${escHtml(packet.updatedAt)}</p>
    <p class="agent-context-consent">Explicit consent · ${packet.viewers.length} named viewer${packet.viewers.length === 1 ? '' : 's'} + publisher</p>
    <h3>Served context receipts</h3>
    <p>Reported by the publishing agent. Receipt metadata records serving; it does not prove evidence was used.</p>
    ${packet.receipts.length ? packet.receipts.map(receipt => `<section class="agent-context-receipt"><h4>${escHtml(receipt.source)}</h4><p class="agent-context-binding">${escHtml(receipt.receiptId)} · Source revision ${escHtml(receipt.revision)}<br>${escHtml(receipt.servedAt)}</p><h5>Omission receipts</h5>${issues(receipt.omission, 'No omissions reported by this receipt.')}</section>`).join('') : '<p>No served receipts reported.</p>'}
    <h3>Unresolved evidence gaps</h3>${issues(packet.gaps, 'No unresolved gaps reported.')}
    </div></article>`;
}

/** Load only the authorized scope list, then retrieve the selected exact revision; stale project results are discarded. */
export async function renderAgentContext(selected?: string, offset = 0): Promise<void> {
  const el = document.getElementById('content-agent-context');
  if (!el) return;
  stopAgentContextValidation();
  const project = state.currentProject;
  const current = ++generation;
  el.replaceChildren();
  if (!project) { el.textContent = 'Select a project to inspect authorized agent context.'; return; }
  el.innerHTML = `<div class="page-header"><div><h1 class="page-title">Agent context</h1><p class="page-subtitle">The question, served evidence, and what is still missing.</p></div><button class="btn btn-secondary" data-refresh>Refresh access</button></div><label class="agent-context-picker">Authorized scope<select class="form-input" data-scope aria-label="Authorized agent scope"></select></label><p role="status" data-status>Checking current consent…</p><div data-packet></div>`;
  const status = el.querySelector<HTMLElement>('[data-status]')!;
  const content = el.querySelector<HTMLElement>('[data-packet]')!;
  const select = el.querySelector<HTMLSelectElement>('[data-scope]')!;
  const active = () => current === generation && state.currentProject?.id === project.id && state.currentView === 'agent-context';
  el.querySelector('[data-refresh]')!.addEventListener('click', () => { void renderAgentContext(select.value, offset); });
  select.addEventListener('change', () => { void renderAgentContext(select.value, offset); });
  try {
    const page = await api<{ packets: Pick<AgentContextPacket, 'id' | 'revision' | 'agent'>[]; nextOffset: number | null }>('GET', `/projects/${project.id}/pm/agent-context?offset=${offset}`);
    if (!active()) return;
    for (const packet of page.packets) { const option = document.createElement('option'); option.value = packet.id; option.textContent = `${packet.agent} · ${packet.id.slice(0, 8)}`; select.append(option); }
    for (const [label, next] of [['First scopes', 0], ['More scopes', page.nextOffset]] as const) {
      if (next === null || (next === 0 && offset === 0)) continue;
      const button = document.createElement('button'); button.className = 'btn btn-secondary'; button.textContent = label; el.querySelector('.agent-context-picker')!.append(button);
      button.addEventListener('click', () => { void renderAgentContext(undefined, next); });
    }
    const metadata = selected ? page.packets.find(row => row.id === selected) : page.packets[0];
    if (!metadata) { if (page.packets.length) { const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose an authorized scope'; placeholder.setAttribute('selected', ''); select.prepend(placeholder); } if (!page.packets.length) select.setAttribute('disabled', ''); status.textContent = selected ? 'Access revoked. This packet is no longer available to your account.' : 'No consented scopes. Ask the publishing agent to share a packet with your account using pm web agent-context publish.'; return; }
    select.querySelector<HTMLOptionElement>(`option[value="${metadata.id}"]`)?.setAttribute('selected', '');
    const packet = await api<AgentContextPacket>('GET', `/projects/${project.id}/pm/agent-context/${metadata.id}?revision=${encodeURIComponent(metadata.revision)}`);
    if (!active()) return;
    content.innerHTML = agentContextMarkup(packet);
    status.textContent = 'Current consent and revision verified.';
    binding = { projectId: project.id, id: packet.id, revision: packet.revision, offset, generation: current };
    scheduleValidation(binding);
    if (packet.publisher === state.user?.id) {
      const button = document.createElement('button'); button.className = 'btn btn-secondary'; button.textContent = 'Revoke this packet'; content.append(button);
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const response = await api<{ queued?: boolean }>('DELETE', `/projects/${project.id}/pm/agent-context/${packet.id}`, { revision: packet.revision });
          if (!active()) return;
          if (response?.queued === true) { status.textContent = 'Revocation queued. Access remains until the server confirms it; reconnect and refresh to check.'; return; }
          await renderAgentContext(packet.id);
        }
        catch (error) { if (active()) { status.textContent = `Revocation failed. ${error instanceof Error ? error.message : 'Refresh and retry.'}`; button.disabled = false; } }
      });
    }
  } catch (error) {
    if (!active()) return;
    content.replaceChildren();
    const payload = error instanceof ApiError ? error.response as { remedy?: string } : undefined;
    const code = error instanceof ApiError ? (error.response as { code?: string }).code : undefined;
    if (code === 'not_found' || code === 'view_only') { revokeAgentContextView(project.id); return; }
    status.textContent = `${error instanceof Error ? error.message : 'Context unavailable.'} ${payload?.remedy ?? 'Refresh access and retry.'}`;
  }
}
