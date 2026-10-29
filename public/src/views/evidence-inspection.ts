import type { EvidenceInspectionPage, EvidenceInspectionRow } from '../../../dist/evidence-inspection.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { escHtml } from '../utils.js';

let clearPanel: (() => void) | undefined;
/** Remove all source bytes immediately when project access, account or connection changes. */
export function invalidateEvidenceInspection(): void { clearPanel?.(); clearPanel = undefined; }
/** Escape source data as plain text and expose fragment omission receipts next to the fragment. */
function fragmentMarkup(label: string, value: EvidenceInspectionRow['cited']): string {
  return `<div><h4>${label}</h4>${value.text === null ? `<p>${escHtml(value.reason || 'unavailable')}. Ask an editor to retain the cited fragment or link an allowed source.</p>` : `<pre>${escHtml(value.text)}</pre>${value.omittedCharacters ? `<p>${value.omittedCharacters} characters omitted.</p>` : ''}`}</div>`;
}
/** Render exactly the machine page facts, without inferring completion from source freshness. */
export function evidenceInspectionMarkup(page: EvidenceInspectionPage): string {
  return `<p>${page.total} evidence records · ${page.omitted} outside this page · ${page.sourceReads} sources read</p>
    <p>Source freshness does not prove completion. Evidence changes require a separately authorized editor.</p>
    ${page.criterionGaps.map(gap => `<p role="note">Criterion facts: ${escHtml(gap.support)}. ${escHtml(gap.remedy || 'Review the current criterion declarations.')}</p>`).join('')}${page.omittedCriterionGaps ? `<p>${page.omittedCriterionGaps} additional criterion gaps omitted.</p>` : ''}
    ${page.rows.map(row => `<article class="evidence-row"><h3>${escHtml(row.source || 'Source unavailable')}</h3>
      <p class="mono">${escHtml(row.citation)}</p><p><strong>${escHtml(row.freshness)}</strong> · ${escHtml(row.resolution)}</p>
      ${row.selector ? `<p class="mono">${escHtml(JSON.stringify(row.selector))}</p>` : ''}
      ${row.remedy ? `<p role="note">${escHtml(row.remedy)}</p>` : ''}
      <div class="evidence-fragments">${fragmentMarkup('Cited fragment', row.cited)}${fragmentMarkup('Current fragment', row.current)}</div>
      <h4>Criterion bindings</h4>${row.bindings.length ? `<ul>${row.bindings.map(binding => `<li>${escHtml(binding.criterion)} — <strong>${escHtml(binding.support)}</strong><p class="mono">Bound revision ${escHtml(binding.boundRevision || 'unknown')}<br>Current revision ${escHtml(binding.revision || 'unknown')}</p></li>`).join('')}</ul>` : '<p>No visible criterion bindings.</p>'}</article>`).join('') || '<p>No citations on this item. An editor can add evidence with pm-evidence.</p>'}`;
}
/** Attach a lazy, live panel to one item sheet; no source results survive a scope or visibility change. */
export function mountEvidenceInspection(root: HTMLElement, project: string, item: string): void {
  invalidateEvidenceInspection();
  const panel = root.querySelector<HTMLDetailsElement>('[data-evidence-panel]');
  if (!panel) return;
  const body = panel.querySelector<HTMLElement>('[data-evidence-body]')!, status = panel.querySelector<HTMLElement>('[data-evidence-status]')!;
  let generation = 0, offset = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  /** Clear existing bytes before any new read or access decision, including pending results. */
  const clear = () => { generation++; controller?.abort(); clearTimeout(timer); body.replaceChildren(); status.textContent = 'Refresh to check current access and source freshness.'; };
  /** Read the page only while this exact sheet and project remain active and visible. */
  const load = async (next = offset): Promise<void> => {
    clear(); offset = next;
    if (!panel.isConnected || !panel.open || panel.getClientRects().length === 0 || document.hidden || state.currentProject?.id !== project || !state.user) return;
    const current = generation; controller = new AbortController(); status.textContent = 'Checking sources…';
    try {
      const page = await api<EvidenceInspectionPage>('GET', `/projects/${project}/pm/evidence/${encodeURIComponent(item)}?offset=${offset}&limit=5&budget=12000`, undefined, controller.signal);
      if (current !== generation || !panel.isConnected || !panel.open || state.currentProject?.id !== project || document.hidden) return;
      body.innerHTML = evidenceInspectionMarkup(page); status.textContent = 'Sources checked. Refresh after a source edit; open panels also check every 10 seconds.';
      if (offset) { const back = document.createElement('button'); back.className = 'btn btn-secondary'; back.textContent = 'First citations'; back.onclick = () => { void load(0); }; body.append(back); }
      if (page.nextOffset !== null) { const more = document.createElement('button'); more.className = 'btn btn-secondary'; more.textContent = 'Next citations'; more.onclick = () => { void load(page.nextOffset!); }; body.append(more); }
      timer = setTimeout(() => { void load(); }, 10000);
    } catch (error) { if (current === generation) { body.replaceChildren(); status.textContent = error instanceof Error ? error.message : 'Inspection unavailable. Refresh project access.'; } }
  };
  panel.querySelector<HTMLButtonElement>('[data-evidence-refresh]')!.onclick = () => { void load(); };
  const visibility = () => { if (document.hidden) clear(); else if (panel.open) void load(); };
  document.addEventListener('visibilitychange', visibility);
  const invalidate = () => { clear(); document.removeEventListener('visibilitychange', visibility); panel.open = false; };
  clearPanel = invalidate;
  panel.ontoggle = () => { if (panel.open) { clearPanel = invalidate; document.addEventListener('visibilitychange', visibility); void load(); } else clear(); };
}
