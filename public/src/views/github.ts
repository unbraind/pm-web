// ═══════════════════════════════════════════════════════════════
// GITHUB VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { confirmDialog } from '../components/modals.js';
import { toast } from '../components/toast.js';

export async function renderGitHubView(): Promise<void> {
  const el = document.getElementById('content-github');
  if (!el) return;
  if (!state.currentProject) { el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>'; return; }

  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">GitHub Integration</div><div class="page-subtitle">${escHtml(state.currentProject.name)}</div></div>
      <div class="page-actions"><button class="btn btn-secondary btn-sm" onclick="window.__app.renderGitHubView()">↺ Refresh</button></div>
    </div>
    <div id="github-content"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;

  if (!state.user?.has_github_token) {
    const contentEl = document.getElementById('github-content');
    if (contentEl) contentEl.innerHTML = `
      <div class="card">
        <div class="card-body">
          <div style="display:flex;align-items:center;gap:10px;padding:12px;background:rgba(251,146,60,0.1);border:1px solid rgba(251,146,60,0.3);border-radius:var(--radius);margin-bottom:16px">
            <span style="font-size:16px">⚠</span>
            <div>
              <div style="font-size:13px;font-weight:500;color:#fb923c">GitHub token required</div>
              <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">Add a GitHub token in <a href="#" onclick="window.__app.showView('settings');return false" style="color:var(--accent)">Settings</a> first to use GitHub integration.</div>
            </div>
          </div>
        </div>
      </div>`;
    return;
  }

  try {
    const data = await api('GET',`/projects/${state.currentProject.id}/github`);
    renderGitHubContent(data as any);
  } catch(err: unknown) {
    const contentEl = document.getElementById('github-content');
    if (contentEl) contentEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

function renderGitHubContent(data: any): void {
  const linked = data.linked;
  const owner = data.owner || '';
  const repo = data.repo || '';

  const tokenBanner = !state.user?.has_github_token ? `
    <div style="display:flex;align-items:center;gap:10px;padding:12px;background:rgba(251,146,60,0.1);border:1px solid rgba(251,146,60,0.3);border-radius:var(--radius);margin-bottom:16px">
      <span style="font-size:16px">⚠</span>
      <div style="font-size:13px;color:var(--text-secondary)">Add a GitHub token in <a href="#" onclick="window.__app.showView('settings');return false" style="color:var(--accent)">Settings</a> first</div>
    </div>` : '';

  const linkPanel = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><div class="card-title">${linked ? 'Linked Repository' : 'Link GitHub Repository'}</div></div>
      <div class="card-body">
        ${tokenBanner}
        ${linked ? `
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
            <span style="font-size:20px">⊙</span>
            <div>
              <div style="font-size:14px;font-weight:600">${escHtml(owner)}/${escHtml(repo)}</div>
              <div style="font-size:12px;color:var(--text-muted)">Linked GitHub repository</div>
            </div>
            <button class="btn btn-danger btn-sm" style="margin-left:auto" onclick="window.__app.unlinkGitHubRepo()">Unlink</button>
          </div>
          <hr class="section-divider">` : ''}
        <div class="two-col" style="margin-bottom:12px">
          <div class="form-group" style="margin-bottom:0">
            <label class="form-label">Owner / Organization</label>
            <input class="form-input" id="gh-owner" type="text" placeholder="octocat" value="${escHtml(owner)}">
          </div>
          <div class="form-group" style="margin-bottom:0">
            <label class="form-label">Repository Name</label>
            <input class="form-input" id="gh-repo" type="text" placeholder="hello-world" value="${escHtml(repo)}">
          </div>
        </div>
        <div class="form-error" id="gh-link-error" style="display:none"></div>
        <button class="btn btn-primary btn-sm" id="gh-link-btn" onclick="window.__app.linkGitHubRepo()"><span>${linked ? 'Update Link' : 'Link Repository'}</span></button>
      </div>
    </div>`;

  const syncPanels = linked ? `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px" class="github-sync-grid">
      <div class="card">
        <div class="card-header">
          <div class="card-title">↓ Import from GitHub</div>
          <button class="btn btn-secondary btn-sm" onclick="window.__app.loadGitHubIssues()">↺ Load Issues</button>
        </div>
        <div class="card-body">
          <div id="github-issues-list">
            <div style="color:var(--text-muted);font-size:13px">Click "Load Issues" to fetch open GitHub issues.</div>
          </div>
          <div id="github-import-result" style="margin-top:12px;display:none"></div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title">↑ Export to GitHub</div>
          <button class="btn btn-secondary btn-sm" onclick="window.__app.loadItemsForPush()">↺ Load Items</button>
        </div>
        <div class="card-body">
          <div id="github-push-list">
            <div style="color:var(--text-muted);font-size:13px">Click "Load Items" to select pm items to push as GitHub issues.</div>
          </div>
          <div id="github-push-result" style="margin-top:12px;display:none"></div>
        </div>
      </div>
    </div>` : '';

  const contentEl = document.getElementById('github-content');
  if (contentEl) contentEl.innerHTML = linkPanel + syncPanels;
}

export async function linkGitHubRepo(): Promise<void> {
  const owner = (document.getElementById('gh-owner') as HTMLInputElement | null)?.value?.trim() || '';
  const repo = (document.getElementById('gh-repo') as HTMLInputElement | null)?.value?.trim() || '';
  const errEl = document.getElementById('gh-link-error') as HTMLElement | null;
  const btn = document.getElementById('gh-link-btn') as HTMLButtonElement | null;
  if (errEl) errEl.style.display = 'none';
  if (!owner || !repo) { if (errEl) { errEl.textContent = 'Owner and repository name are required'; errEl.style.display = 'block'; } return; }
  if (btn) { btn.disabled = true; const sp = btn.querySelector('span'); if (sp) sp.textContent = 'Linking…'; }
  try {
    await api('PATCH',`/projects/${state.currentProject!.id}/github`,{owner,repo});
    toast('Repository linked','success');
    renderGitHubView();
  } catch(err: unknown) {
    if (errEl) { errEl.textContent = err instanceof Error ? err.message : String(err); errEl.style.display = 'block'; }
    if (btn) { btn.disabled = false; const sp = btn.querySelector('span'); if (sp) sp.textContent = 'Link Repository'; }
  }
}

export function unlinkGitHubRepo(): void {
  confirmDialog('Unlink Repository?', 'GitHub integration will be disabled for this project.', async () => {
    try {
      await api('PATCH',`/projects/${state.currentProject!.id}/github`,{owner:'',repo:''});
      toast('Repository unlinked','success');
      renderGitHubView();
    } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
  });
}

export async function loadGitHubIssues(): Promise<void> {
  const el = document.getElementById('github-issues-list');
  if (!el) return;
  el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  try {
    const data = await api('GET',`/projects/${state.currentProject!.id}/github/issues`);
    const issues = (data as any).issues || [];
    if (issues.length === 0) {
      el.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No open issues found in this repository.</div>';
      return;
    }
    el.innerHTML = `
      <div style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:12px;color:var(--text-muted)">${issues.length} open issue${issues.length!==1?'s':''} — select to import</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="window.__app.selectAllIssues(true)">Select All</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__app.selectAllIssues(false)">None</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;max-height:360px;overflow-y:auto;margin-bottom:12px">
        ${issues.map((i: any)=>`
          <label style="display:flex;align-items:flex-start;gap:10px;padding:8px 10px;background:var(--bg-card2);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;transition:var(--transition)" onmouseover="this.style.borderColor='var(--border-light)'" onmouseout="this.style.borderColor='var(--border)'">
            <input type="checkbox" class="gh-issue-cb" data-number="${escHtml(String(i.number))}" style="margin-top:2px;accent-color:var(--accent)">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:500">${escHtml(i.title||'')}</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px">#${escHtml(String(i.number))}${i.labels?.length?` · ${i.labels.map((l: any)=>escHtml(l.name||l)).join(', ')}`:''}</div>
            </div>
          </label>`).join('')}
      </div>
      <button class="btn btn-primary btn-sm" id="gh-import-btn" onclick="window.__app.importGitHubIssues()"><span>Import Selected</span></button>`;
  } catch(err: unknown) {
    el.innerHTML = `<div style="color:var(--status-blocked);font-size:13px">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

export function selectAllIssues(checked: boolean): void {
  document.querySelectorAll('.gh-issue-cb').forEach(cb => { (cb as HTMLInputElement).checked = checked; });
}

export async function loadItemsForPush(): Promise<void> {
  const el = document.getElementById('github-push-list');
  if (!el) return;
  el.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  try {
    const [itemsData, linksData] = await Promise.all([
      api('GET', `/projects/${state.currentProject!.id}/pm/list-all?limit=200`) as Promise<{ items?: any[] }>,
      api('GET', `/projects/${state.currentProject!.id}/github/links`) as Promise<{ links?: Array<{ pm_item_id: string; issue_number: number; issue_url: string }> }>,
    ]);
    const items = itemsData.items || [];
    const links = linksData.links || [];
    const linkMap = new Map(links.map(l => [l.pm_item_id, l]));

    if (items.length === 0) {
      el.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No open items in this project.</div>';
      return;
    }
    el.innerHTML = `
      <div style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:12px;color:var(--text-muted)">${items.length} item${items.length!==1?'s':''} — select to push as issues</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="window.__app.selectAllPushItems(true)">All</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__app.selectAllPushItems(false)">None</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;max-height:300px;overflow-y:auto;margin-bottom:12px">
        ${items.map((i: any) => {
          const link = linkMap.get(i.id);
          const linkedBadge = link ? `<a href="${escHtml(link.issue_url)}" target="_blank" rel="noopener" style="font-size:10px;color:var(--accent);margin-top:2px;display:block">#${link.issue_number} ↗</a>` : '';
          const updateBtn = link ? `<button class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 6px" onclick="window.__app.updateGitHubIssue('${escHtml(i.id)}')">Update</button>` : '';
          return `
          <label style="display:flex;align-items:flex-start;gap:10px;padding:8px 10px;background:var(--bg-card2);border:1px solid ${link ? 'var(--accent-muted,#334)' : 'var(--border)'};border-radius:var(--radius);cursor:pointer;transition:var(--transition)">
            <input type="checkbox" class="gh-push-cb" data-item-id="${escHtml(i.id)}" style="margin-top:2px;accent-color:var(--accent)">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(i.title||i.id)}</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:1px">${escHtml(i.id)} · ${escHtml(i.type||'Task')} · ${escHtml(i.status||'open')}${linkedBadge}</div>
            </div>
            ${updateBtn}
          </label>`;
        }).join('')}
      </div>
      <button class="btn btn-primary btn-sm" id="gh-push-btn" onclick="window.__app.pushItemsToGitHub()"><span>Push to GitHub</span></button>`;
  } catch(err: unknown) {
    el.innerHTML = `<div style="color:var(--status-blocked);font-size:13px">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div>`;
  }
}

export function selectAllPushItems(checked: boolean): void {
  document.querySelectorAll('.gh-push-cb').forEach(cb => { (cb as HTMLInputElement).checked = checked; });
}

export async function pushItemsToGitHub(): Promise<void> {
  const checked = Array.from(document.querySelectorAll('.gh-push-cb:checked'));
  if (checked.length === 0) { toast('Select at least one item to push', 'info'); return; }
  const itemIds = checked.map(cb => (cb as HTMLInputElement).dataset['itemId'] || '').filter(Boolean);
  const btn = document.getElementById('gh-push-btn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; const sp = btn.querySelector('span'); if (sp) sp.textContent = `Pushing ${itemIds.length}…`; }
  const resultEl = document.getElementById('github-push-result');
  if (resultEl) resultEl.style.display = 'none';
  try {
    const data = await api('POST', `/projects/${state.currentProject!.id}/github/push`, { itemIds }) as { pushed?: any[]; errors?: any[]; total?: number };
    const pushed = data.pushed || [];
    const errors = data.errors || [];
    toast(`Pushed ${pushed.length} item${pushed.length!==1?'s':''}${errors.length?' ('+errors.length+' error'+( errors.length!==1?'s':'')+')':''}`, errors.length ? 'info' : 'success');
    if (resultEl) {
      resultEl.style.display = '';
      resultEl.innerHTML = `
        <div style="background:var(--bg-card2);border:1px solid var(--border);border-radius:var(--radius);padding:12px">
          <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Push Results</div>
          ${pushed.length > 0 ? `<div style="color:var(--status-closed);font-size:13px;margin-bottom:6px">✓ Pushed ${pushed.length}: ${pushed.map((p: any)=>`<a href="${escHtml(p.issueUrl)}" target="_blank" style="color:var(--accent)">#${p.issueNumber}</a>`).join(', ')}</div>` : ''}
          ${errors.length > 0 ? `<div style="color:var(--status-blocked);font-size:13px">✗ ${errors.length} failed: ${errors.map((e: any)=>escHtml(String(e))).join('; ')}</div>` : ''}
        </div>`;
    }
    loadItemsForPush();
  } catch(err: unknown) {
    toast(`Push failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; const sp = btn.querySelector('span'); if (sp) sp.textContent = 'Push to GitHub'; }
  }
}

export async function updateGitHubIssue(itemId: string): Promise<void> {
  try {
    const data = await api('PATCH', `/projects/${state.currentProject!.id}/github/push/${encodeURIComponent(itemId)}`) as { ok?: boolean; issueNumber?: number; issueUrl?: string };
    toast(`Updated GitHub issue #${data.issueNumber}`, 'success');
    loadItemsForPush();
  } catch(err: unknown) {
    toast(`Update failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

export async function importGitHubIssues(): Promise<void> {
  const checked = Array.from(document.querySelectorAll('.gh-issue-cb:checked'));
  if (checked.length === 0) { toast('Select at least one issue to import','info'); return; }
  const issueNumbers = checked.map(cb => parseInt((cb as HTMLInputElement).dataset.number || '0', 10));
  const btn = document.getElementById('gh-import-btn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; const sp = btn.querySelector('span'); if (sp) sp.textContent = `Importing ${issueNumbers.length}…`; }
  const resultEl = document.getElementById('github-import-result');
  if (resultEl) resultEl.style.display = 'none';
  try {
    const data = await api('POST',`/projects/${state.currentProject!.id}/github/import`,{issueNumbers});
    const created = (data as any).created || [];
    const errors = (data as any).errors || [];
    toast(`Imported ${created.length} issue${created.length!==1?'s':''}${errors.length?' ('+errors.length+' error'+( errors.length!==1?'s':'')+')':''}`, errors.length ? 'info' : 'success');
    if (resultEl) {
      resultEl.style.display = '';
      resultEl.innerHTML = `
        <div style="background:var(--bg-card2);border:1px solid var(--border);border-radius:var(--radius);padding:12px">
          <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Import Results</div>
          ${created.length > 0 ? `<div style="color:var(--status-closed);font-size:13px;margin-bottom:6px">✓ Created ${created.length} item${created.length!==1?'s':''}: ${created.map((id: any)=>`<span class="mono" style="font-size:11px">${escHtml(String(id))}</span>`).join(', ')}</div>` : ''}
          ${errors.length > 0 ? `<div style="color:var(--status-blocked);font-size:13px">✗ ${errors.length} error${errors.length!==1?'s':''}: ${errors.map((e: any)=>escHtml(String(e.message||e))).join('; ')}</div>` : ''}
        </div>`;
    }
    // loadItemsBadge is in projects.ts, import via app bridge
    if ((window as any).__app?.loadItemsBadge) (window as any).__app.loadItemsBadge();
  } catch(err: unknown) {
    toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`,'error');
  } finally {
    if (btn) { btn.disabled = false; const sp = btn.querySelector('span'); if (sp) sp.textContent = 'Import Selected'; }
  }
}
