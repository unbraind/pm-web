import type { ContractExplorerPage, ContractReview } from '../../../dist/contract-explorer.js';
import { state } from '../state.js';
import { api, ApiError } from '../api.js';
import { escHtml } from '../utils.js';
let generation = 0;

/** Render SDK availability consistently for directory, Postgres and remote snapshots; no execution control exists. */
export function contractExplorerMarkup(page: ContractExplorerPage, canEdit: boolean): string {
  return `<p class="contract-summary"><code>${escHtml(page.backend)}</code> · ${page.total} operations · Review only</p>
    <p>Inspect capabilities, select an operation and review its inputs. Previews never run the operation.</p>
    <div class="contract-table"><table><caption>Backend operation availability</caption><thead><tr><th scope="col">Operation</th><th scope="col">Provider</th><th scope="col">Availability</th><th scope="col">Review</th></tr></thead><tbody>${page.operations.map(row => `<tr><th scope="row"><code>${escHtml(row.action)}</code><small>${escHtml(row.command ?? 'No CLI command')}</small></th><td>${escHtml(row.provider)}${row.mutation ? ' · may change data' : ''}</td><td><strong>${escHtml(row.status)}</strong><small>${escHtml(row.remedy)}</small></td><td><button class="btn btn-secondary btn-sm" data-contract-action="${escHtml(row.action)}" ${row.status !== 'available' || (row.mutation && !canEdit) ? 'disabled' : ''}>Review inputs</button></td></tr>`).join('')}</tbody></table></div>
    ${page.nextOffset === null ? '' : `<button class="btn btn-secondary" data-contract-next="${page.nextOffset}">Next operations</button>`}`;
}

/** Retain typed remedies while keeping raw network or storage diagnostics out of the page. */
function refusalText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.response as { code?: string; remedy?: string };
    if (body.code && body.remedy) return `${body.code}: ${body.remedy}`;
  }
  return 'Capabilities unavailable. Check project access and backend connectivity, then refresh.';
}

/** Start each page in a disabled loading state and discard late results from another selected project. */
export async function renderContractExplorer(offset = 0): Promise<void> {
  const root = document.getElementById('content-contract-explorer');
  if (!root) return;
  const project = state.currentProject, epoch = ++generation;
  root.innerHTML = '<div class="view-header"><h1>Backend contracts</h1><button class="btn btn-secondary" data-contract-refresh>Refresh capabilities</button></div><div data-contract-status role="status">Checking capabilities…</div><div data-contract-list></div><section data-contract-review aria-label="Operation review"></section>';
  root.querySelector('[data-contract-refresh]')!.addEventListener('click', () => { void renderContractExplorer(); });
  const status = root.querySelector<HTMLElement>('[data-contract-status]')!;
  if (!project) { status.textContent = 'Select a project to inspect its backend.'; return; }
  const current = () => epoch === generation && state.currentProject?.id === project.id && state.currentView === 'contract-explorer';
  try {
    const page = await api<ContractExplorerPage>('GET', `/projects/${project.id}/pm/contracts?offset=${offset}`);
    if (!current()) return;
    const list = root.querySelector<HTMLElement>('[data-contract-list]')!;
    list.innerHTML = `${offset > 0 ? '<button class="btn btn-secondary" data-contract-first>First operations</button>' : ''}${contractExplorerMarkup(page, project.permission === 'edit')}`; status.textContent = '';
    list.querySelector('[data-contract-first]')?.addEventListener('click', () => { void renderContractExplorer(); });
    list.querySelector<HTMLButtonElement>('[data-contract-next]')?.addEventListener('click', event => { void renderContractExplorer(Number((event.currentTarget as HTMLElement).dataset.contractNext)); });
    list.querySelectorAll<HTMLButtonElement>('[data-contract-action]').forEach(button => button.addEventListener('click', () => { void openReview(button.dataset.contractAction!); }));
  } catch (error) { if (current()) status.textContent = refusalText(error); }

  /** Fetch a fresh schema before showing a review form, with no apply/execute path. */
  async function openReview(action: string): Promise<void> {
    root!.querySelector<HTMLElement>('[data-contract-review]')!.replaceChildren(); status.textContent = 'Refreshing operation contract…';
    const selection = ++reviewGeneration;
    try {
      const detail = await api<ContractExplorerPage>('GET', `/projects/${project!.id}/pm/contracts?action=${encodeURIComponent(action)}`);
      if (!current() || selection !== reviewGeneration) return;
      const operation = detail.operations[0];
      if (!operation || operation.status !== 'available') { status.textContent = operation?.remedy ?? 'Refresh capabilities before reviewing.'; return; }
      const panel = root!.querySelector<HTMLElement>('[data-contract-review]')!;
      panel.innerHTML = `<h2>Review ${escHtml(action)}</h2><details><summary>SDK input schema</summary><pre>${escHtml(JSON.stringify(detail.schema ?? {}, null, 2))}</pre></details><form><label>Input JSON<textarea class="form-input" name="input" rows="6" required maxlength="12288">{}</textarea></label><button class="btn btn-primary" type="submit">Preview inputs</button></form><pre data-contract-result role="status"></pre>`;
      status.textContent = '';
      panel.querySelector('form')!.addEventListener('submit', async event => {
        event.preventDefault(); const button = panel.querySelector<HTMLButtonElement>('button')!, result = panel.querySelector<HTMLElement>('[data-contract-result]')!;
        button.disabled = true;
        try {
          const input: unknown = JSON.parse(panel.querySelector<HTMLTextAreaElement>('textarea')!.value);
          const preview = await api<ContractReview>('POST', `/projects/${project!.id}/pm/contracts/review`, { action, input });
          if (current() && selection === reviewGeneration) result.textContent = JSON.stringify(preview, null, 2);
        } catch (error) { if (current() && selection === reviewGeneration) result.textContent = error instanceof SyntaxError ? 'invalid_input: Enter a JSON object.' : refusalText(error); }
        finally { button.disabled = false; }
      });
    } catch (error) { if (current() && selection === reviewGeneration) status.textContent = refusalText(error); }
  }
  let reviewGeneration = 0;
}
