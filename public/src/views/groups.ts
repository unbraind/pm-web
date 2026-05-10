// ═══════════════════════════════════════════════════════════════
// GROUPS VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml } from '../utils.js';
import { showModal, hideModal, createModal, confirmDialog } from '../components/modals.js';
import { toast } from '../components/toast.js';

export async function renderGroupsView(): Promise<void> {
  const el = document.getElementById('content-groups');
  if (!el) return;
  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Groups</div><div class="page-subtitle">Manage your teams</div></div>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" onclick="window.__app.renderGroupsView()">↺ Refresh</button>
        <button class="btn btn-primary" onclick="window.__app.openCreateGroupModal()">+ New Group</button>
      </div>
    </div>
    <div id="groups-list"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;
  await loadGroups();
}

async function loadGroups(): Promise<void> {
  const el = document.getElementById('groups-list');
  if (!el) return;
  try {
    const data = await api('GET','/groups');
    const groups = (data as any).groups || [];
    if (groups.length === 0) {
      el.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">◉</div>
          <div class="empty-state-text">No groups yet</div>
          <div class="empty-state-sub">Create a group to share projects with multiple teammates at once</div>
        </div>`;
      return;
    }
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">
      ${groups.map((g: any)=>`
        <div class="group-row" onclick="window.__app.openGroupDetail('${escHtml(g.id)}','${escHtml(g.name)}')">
          <div style="width:36px;height:36px;border-radius:50%;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:var(--accent);flex-shrink:0">
            ${escHtml((g.name||'?').slice(0,2).toUpperCase())}
          </div>
          <div style="flex:1">
            <div class="group-name">${escHtml(g.name)}</div>
            ${g.description ? `<div class="group-desc">${escHtml(g.description)}</div>` : ''}
          </div>
          <span class="sidebar-badge">${g.memberCount||g.members?.length||0} members</span>
          <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();window.__app.deleteGroup('${escHtml(g.id)}','${escHtml(g.name)}')">Delete</button>
        </div>`).join('')}
    </div>`;
  } catch(err: unknown) {
    if (el) el.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

export function openCreateGroupModal(): void {
  createModal('create-group-modal','New Group',`
    <div class="form-group">
      <label class="form-label">Group Name *</label>
      <input class="form-input" id="cg-name" type="text" placeholder="Engineering Team" required>
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <input class="form-input" id="cg-desc" type="text" placeholder="What is this group for?">
    </div>
    <div class="form-error" id="cg-error" style="display:none"></div>`,
    `<button class="btn btn-ghost" onclick="window.__app.hideModal('create-group-modal')">Cancel</button>
     <button class="btn btn-primary" onclick="window.__app.submitCreateGroup()"><span>Create Group</span></button>`
  );
  showModal('create-group-modal');
}

export async function submitCreateGroup(): Promise<void> {
  const name = (document.getElementById('cg-name') as HTMLInputElement | null)?.value?.trim() || '';
  const description = (document.getElementById('cg-desc') as HTMLInputElement | null)?.value?.trim() || '';
  const errEl = document.getElementById('cg-error') as HTMLElement | null;
  if (errEl) errEl.style.display = 'none';
  if (!name) { if (errEl) { errEl.textContent = 'Group name is required'; errEl.style.display = 'block'; } return; }
  try {
    await api('POST','/groups',{name,description});
    toast('Group created','success');
    hideModal('create-group-modal');
    await loadGroups();
  } catch(err: unknown) {
    if (errEl) { errEl.textContent = err instanceof Error ? err.message : String(err); errEl.style.display = 'block'; }
  }
}

export function deleteGroup(groupId: string, name: string): void {
  confirmDialog('Delete Group?', `Delete group "${name}"? This cannot be undone.`, async () => {
    try {
      await api('DELETE',`/groups/${groupId}`);
      toast('Group deleted','success');
      await loadGroups();
    } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
  }, true);
}

export async function openGroupDetail(groupId: string, _groupName: string): Promise<void> {
  createModal('group-detail-modal', _groupName,
    `<div class="loading-state"><div class="loading-spinner"></div></div>`, '', true);
  showModal('group-detail-modal');

  try {
    const data = await api('GET','/groups');
    const groups = (data as any).groups || [];
    const group = groups.find((g: any)=>g.id===groupId) || {id:groupId,name:_groupName,members:[]};
    const members = group.members || [];

    const membersHtml = members.length === 0
      ? `<div style="color:var(--text-muted);font-size:13px">No members yet</div>`
      : members.map((m: any)=>`
          <div class="member-row">
            <div class="member-avatar">${escHtml((m.displayName||m.email||'?').slice(0,2).toUpperCase())}</div>
            <div style="flex:1">
              <div style="font-size:13px;font-weight:500">${escHtml(m.displayName||m.email||m.userId||'Unknown')}</div>
              ${m.email&&m.displayName?`<div class="group-desc">${escHtml(m.email)}</div>`:''}
            </div>
            <button class="btn btn-danger btn-sm" onclick="window.__app.removeMember('${escHtml(groupId)}','${escHtml(m.userId||m.id||'')}')">Remove</button>
          </div>`).join('');

    const bodyEl = document.getElementById('group-detail-modal')?.querySelector('.modal-body');
    if (bodyEl) {
      bodyEl.innerHTML = `
        <div style="margin-bottom:20px">
          <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">
            Members (${members.length})
          </div>
          ${membersHtml}
        </div>
        <hr class="section-divider">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">
          Invite Member
        </div>
        <div class="row">
          <input class="form-input flex-1" id="invite-email-${escHtml(groupId)}" type="email" placeholder="colleague@example.com">
          <button class="btn btn-primary btn-sm" onclick="window.__app.inviteMember('${escHtml(groupId)}')">Invite</button>
        </div>`;
    }
  } catch(err: unknown) {
    const bodyEl = document.getElementById('group-detail-modal')?.querySelector('.modal-body');
    if (bodyEl) bodyEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

export async function inviteMember(groupId: string): Promise<void> {
  const emailEl = document.getElementById(`invite-email-${groupId}`) as HTMLInputElement | null;
  const email = emailEl?.value?.trim() || '';
  if (!email) { toast('Email is required','error'); return; }
  try {
    await api('POST',`/groups/${groupId}/members`,{email});
    toast('Member invited','success');
    if (emailEl) emailEl.value = '';
    openGroupDetail(groupId, '');
  } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
}

export function removeMember(groupId: string, userId: string): void {
  confirmDialog('Remove Member?', 'Remove this member from the group?', async () => {
    try {
      await api('DELETE',`/groups/${groupId}/members/${userId}`);
      toast('Member removed','success');
      openGroupDetail(groupId, '');
    } catch(err: unknown) { toast(err instanceof Error ? err.message : String(err),'error'); }
  });
}
