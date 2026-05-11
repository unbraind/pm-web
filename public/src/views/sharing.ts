// ═══════════════════════════════════════════════════════════════
// SHARING VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { showModal, hideModal, createModal, confirmDialog } from '../components/modals.js';
import { toast } from '../components/toast.js';

function shareDisplay(share: any): { name: string; detail: string; avatar: string; isGroup: boolean } {
  const isGroup = Boolean(share.group_id || share.groupId);
  const name = isGroup
    ? (share.group_name || share.groupName || 'Unknown group')
    : (share.user_display_name || share.userDisplayName || share.user_email || share.email || share.user_id || share.userId || 'Unknown user');
  const detail = isGroup
    ? 'Group'
    : (share.user_email || share.email || '');
  return { name, detail, avatar: name.slice(0, 2).toUpperCase(), isGroup };
}

export async function renderSharingView(): Promise<void> {
  const el = document.getElementById('content-sharing');
  if (!el) return;
  if (!state.currentProject) { el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>'; return; }
  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Project Sharing</div>
        <div class="page-subtitle">Manage access to ${escHtml(state.currentProject.name)}</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" onclick="window.__app.renderSharingView()">↺ Refresh</button>
        <button class="btn btn-primary" onclick="window.__app.openShareModal()">+ Invite</button>
      </div>
    </div>
    <div id="shares-list"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;
  await loadShares();
}

async function loadShares(): Promise<void> {
  const el = document.getElementById('shares-list');
  if (!el) return;
  try {
    const data = await api('GET',`/projects/${state.currentProject!.id}/shares`);
    const shares = (data as any).shares || [];
    if (shares.length === 0) {
      el.innerHTML = `
        <div class="card">
          <div class="card-body">
            <div class="empty-state" style="padding:32px">
              <div class="empty-state-icon">⇄</div>
              <div class="empty-state-text">Not shared with anyone yet</div>
              <div class="empty-state-sub">Invite teammates by email to collaborate</div>
            </div>
          </div>
        </div>`;
      return;
    }
    el.innerHTML = `
      <div class="card">
        <div class="card-header"><div class="card-title">Shared with</div></div>
        <div class="card-body">
          ${shares.map((s: any)=>`
            ${(() => {
              const display = shareDisplay(s);
              return `
            <div class="share-row">
              <div class="member-avatar">${escHtml(display.avatar)}</div>
              <div style="flex:1">
                <div style="font-size:13px;font-weight:500">${escHtml(display.name)}</div>
                <div class="group-desc">${escHtml(display.detail)}</div>
              </div>
              <span class="share-perm">${escHtml(s.permission||'view')}</span>
              <button class="btn btn-danger btn-sm" onclick="window.__app.removeShare('${escHtml(s.id||s.shareId||'')}')">Remove</button>
            </div>`;
            })()}`).join('')}
        </div>
      </div>`;
  } catch(err: unknown) {
    if (el) el.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

export function openShareModal(): void {
  createModal('share-modal','Invite to Project',`
    <div class="form-group">
      <label class="form-label">Email Address</label>
      <input class="form-input" id="share-email" type="email" placeholder="colleague@example.com">
    </div>
    <div class="form-group">
      <label class="form-label">Or Group ID</label>
      <input class="form-input" id="share-group-id" type="text" placeholder="Leave empty to invite by email">
    </div>
    <div class="form-group">
      <label class="form-label">Permission</label>
      <select class="form-select" id="share-permission">
        <option value="view">View — read-only access</option>
        <option value="edit">Edit — can create and modify items</option>
      </select>
    </div>
    <div class="form-error" id="share-error" style="display:none"></div>`,
    `<button class="btn btn-ghost" onclick="window.__app.hideModal('share-modal')">Cancel</button>
     <button class="btn btn-primary" onclick="window.__app.submitShare()"><span>Send Invite</span></button>`
  );
  showModal('share-modal');
}

export async function submitShare(): Promise<void> {
  const email = (document.getElementById('share-email') as HTMLInputElement | null)?.value?.trim() || '';
  const groupId = (document.getElementById('share-group-id') as HTMLInputElement | null)?.value?.trim() || '';
  const permission = (document.getElementById('share-permission') as HTMLSelectElement | null)?.value || 'view';
  const errEl = document.getElementById('share-error') as HTMLElement | null;
  if (errEl) errEl.style.display = 'none';
  if (!email && !groupId) {
    if (errEl) { errEl.textContent = 'Email or Group ID is required'; errEl.style.display = 'block'; }
    return;
  }
  const body: Record<string, string> = { permission };
  if (email) body.email = email;
  if (groupId) body.groupId = groupId;
  try {
    await api('POST',`/projects/${state.currentProject!.id}/shares`,body);
    toast('Project shared successfully','success');
    hideModal('share-modal');
    await loadShares();
  } catch(err: unknown) {
    if (errEl) { errEl.textContent = err instanceof Error ? err.message : String(err); errEl.style.display = 'block'; }
  }
}

export function removeShare(shareId: string): void {
  confirmDialog('Remove Access?', 'The user will lose access to this project.', async () => {
    try {
      await api('DELETE',`/projects/${state.currentProject!.id}/shares/${shareId}`);
      toast('Share removed','success');
      await loadShares();
    } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
  });
}
