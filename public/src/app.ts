// ═══════════════════════════════════════════════════════════════
// APP — Main entry point
// ═══════════════════════════════════════════════════════════════
import { state } from './state.js';
import { api } from './api.js';
import { showView, setOnViewChange } from './views/router.js';
import { loadProjects, onProjectSelect, loadItemsBadge, renderProjectsView, selectProject, deleteProject, buildCreateProjectModal, submitCreateProject, submitCreateProject2 } from './views/projects.js';
import { renderItemsView, fetchAndRenderItems, openItemDetail, switchDetailTab, addComment, addNote, appendItem, updateItem, closeItem, confirmDeleteItem, claimItem, releaseItem, startItem, pauseItem, addDep, removeDep, addLearning, addTest, addFileLink, setStatusFilter, applyItemFilters, clearFilters, showBulkUpdateModal, previewBulkUpdate, applyBulkUpdate, showBulkCloseModal, previewBulkClose, applyBulkClose, useItemAsTemplate } from './views/items.js';
import { submitCreateItem, submitCreateItemAndOpen } from './views/create.js';
import { renderActivityView } from './views/activity.js';
import { renderSearchView, setSearchMode, reindexProject, debouncedSearch, doSearch } from './views/search.js';
import { renderStatsView } from './views/stats.js';
import { renderCalendarView, calNav, showDayItems } from './views/calendar.js';
import { renderContextView } from './views/context.js';
import { renderGraphView } from './views/graph.js';

// Open graph view focused on a specific node
async function openGraphAt(nodeId: string): Promise<void> {
  showView('graph');
  // Give the graph view time to mount, then set selected node
  setTimeout(async () => {
    await renderGraphView();
    // Select the node via the graph canvas
    const appw = window as unknown as { __graphSelectNode?: (id: string) => void };
    appw.__graphSelectNode?.(nodeId);
  }, 50);
}
import { renderSharingView, openShareModal, submitShare, removeShare } from './views/sharing.js';
import { renderGroupsView, openCreateGroupModal, submitCreateGroup, deleteGroup, openGroupDetail, inviteMember, removeMember } from './views/groups.js';
import { renderHealthView } from './views/health.js';
import { renderDedupeAuditView } from './views/dedupe.js';
import { renderValidateView } from './views/validate.js';
import { renderSettingsView, saveProfile, changePassword, saveGitHubToken, clearGitHubToken } from './views/settings.js';
import { renderGitHubView, linkGitHubRepo, unlinkGitHubRepo, loadGitHubIssues, selectAllIssues, importGitHubIssues, loadItemsForPush, selectAllPushItems, pushItemsToGitHub, updateGitHubIssue } from './views/github.js';
import { renderExportView, exportData, importData } from './views/export.js';
import { renderNormalizeView, applyNormalize } from './views/normalize.js';
import { renderSharedView } from './views/shared.js';
import { renderTemplatesView, createFromTemplate } from './views/templates.js';
import { renderCommentsAuditView } from './views/comments-audit.js';
import { renderConfigView, configAddArrayItem, configRemoveArrayItem, configSaveArray, configSaveSimple, configSaveObject } from './views/config.js';
import { renderGuideView } from './views/guide.js';
import { renderAdminView, setAdminRole, adminSwitchTab, adminDeleteUser, adminDeleteProject, adminDeleteGroup, adminFilterUsers, adminFilterProjects, adminFilterAudit, adminSetPage, adminCreateGroup } from './views/admin.js';
import { switchAuthTab, submitAuth, logout, showAuth } from './views/auth.js';
import { initPlanView, openPlanDetail, openCreatePlanModal, submitCreatePlan, openAddStepModal, submitAddStep, planCompleteStep, planBlockStepPrompt, submitBlockStep, planRemoveStep, planApprove, planMaterializePrompt, submitMaterializePlan, planEditPrompt, submitEditPlan, planDeletePrompt } from './views/plan.js';
import { showModal, hideModal, createModal, closeAllModals } from './components/modals.js';
import { toast } from './components/toast.js';
import { escHtml } from './utils.js';

// Global search modal
let globalSearchTimer: ReturnType<typeof setTimeout>;

function buildSearchModal(): void {
  createModal('global-search-modal','Search',`
    <div class="search-box-wrap" style="margin-bottom:12px">
      <span class="search-icon">⌕</span>
      <input class="search-input" id="global-search-input" type="text" placeholder="Search items…" oninput="window.__app.globalSearchDebounced()">
    </div>
    <div id="global-search-results">
      <div class="empty-state" style="padding:24px"><div class="empty-state-text">Type to search</div></div>
    </div>`,'');
}

type MobileCommand = {
  view: string;
  title: string;
  desc: string;
  icon: string;
  requiresProject?: boolean;
};

const mobileCommandGroups: Array<{ title: string; commands: MobileCommand[] }> = [
  {
    title: 'Plan and Execute',
    commands: [
      { view: 'items', title: 'Items', desc: 'Browse, filter, edit, and close work.', icon: '≡', requiresProject: true },
      { view: 'create', title: 'Create Item', desc: 'Add tasks, features, bugs, reminders, and more.', icon: '+', requiresProject: true },
      { view: 'plan', title: 'Plans', desc: 'Create and manage structured agentic plans with steps.', icon: '◧', requiresProject: true },
      { view: 'calendar', title: 'Calendar', desc: 'Review deadlines, reminders, and scheduled work.', icon: '◷', requiresProject: true },
      { view: 'templates', title: 'Templates', desc: 'Create from saved pm templates.', icon: '⎘', requiresProject: true },
    ],
  },
  {
    title: 'Inspect and Maintain',
    commands: [
      { view: 'search', title: 'Search', desc: 'Keyword, semantic, and hybrid search.', icon: '⌕', requiresProject: true },
      { view: 'stats', title: 'Stats', desc: 'Counts, distributions, and project summary.', icon: '◈', requiresProject: true },
      { view: 'graph', title: 'Graph', desc: 'Knowledge and dependency graph.', icon: '◎', requiresProject: true },
      { view: 'health', title: 'Health', desc: 'Find stale, blocked, or weakly specified work.', icon: '♥', requiresProject: true },
      { view: 'activity', title: 'Activity', desc: 'Audit recent project changes.', icon: '◎', requiresProject: true },
      { view: 'dedupe', title: 'Dedupe Audit', desc: 'Find possible duplicate items.', icon: '⧖', requiresProject: true },
      { view: 'validate', title: 'Validate', desc: 'Run pm validation checks.', icon: '✓', requiresProject: true },
      { view: 'normalize', title: 'Normalize', desc: 'Preview and apply lifecycle cleanup.', icon: '⊞', requiresProject: true },
      { view: 'comments-audit', title: 'Comments Audit', desc: 'Review latest comments across items.', icon: '💬', requiresProject: true },
    ],
  },
  {
    title: 'Collaborate and Connect',
    commands: [
      { view: 'sharing', title: 'Sharing', desc: 'Manage project access.', icon: '⇄', requiresProject: true },
      { view: 'groups', title: 'Groups', desc: 'Create groups and manage members.', icon: '◉' },
      { view: 'shared', title: 'Shared with Me', desc: 'Open projects shared by other users.', icon: '⇄' },
      { view: 'github', title: 'GitHub', desc: 'Link repositories and import issues.', icon: '⊙', requiresProject: true },
    ],
  },
  {
    title: 'Project Tools',
    commands: [
      { view: 'projects', title: 'All Projects', desc: 'Switch or create a workspace.', icon: '⊞' },
      { view: 'context', title: 'Context', desc: 'Generate agent-ready project context.', icon: '⚙', requiresProject: true },
      { view: 'config', title: 'Config', desc: 'Edit project settings.', icon: '⚒', requiresProject: true },
      { view: 'export', title: 'Export / Import', desc: 'Download or upload project data.', icon: '↕', requiresProject: true },
      { view: 'guide', title: 'Guide', desc: 'Read pm workflow guidance.', icon: '📖', requiresProject: true },
      { view: 'settings', title: 'Account Settings', desc: 'Profile, password, and GitHub token.', icon: '⚙' },
      { view: 'admin', title: 'Admin', desc: 'Manage users, projects, groups, and roles.', icon: '◇' },
    ],
  },
];

function buildMobileCommandSheet(): void {
  const hasProject = !!state.currentProject;
  const projectName = state.currentProject?.name || 'No project selected';
  const body = `
    <div class="mobile-command-intro">
      <div class="mobile-command-project">
        <div class="mobile-command-project-label">Current workspace</div>
        <div class="mobile-command-project-name">${escHtml(projectName)}</div>
      </div>
      <div class="mobile-command-sync"><span class="sse-dot"></span>${hasProject ? 'Live sync' : 'Select project'}</div>
    </div>
    ${mobileCommandGroups.map(group => `
      <div class="mobile-command-group">
        <div class="mobile-command-group-title">${escHtml(group.title)}</div>
        <div class="mobile-command-grid">
          ${group.commands.filter(command => command.view !== 'admin' || state.user?.is_admin).map(command => {
            const disabled = command.requiresProject && !hasProject;
            return `
              <button class="mobile-command" ${disabled ? 'disabled' : ''} onclick="window.__app.runMobileCommand('${command.view}')">
                <span class="mobile-command-top">
                  <span class="mobile-command-icon">${escHtml(command.icon)}</span>
                  <span class="mobile-command-title">${escHtml(command.title)}</span>
                </span>
                <span class="mobile-command-desc">${escHtml(command.desc)}</span>
              </button>`;
          }).join('')}
        </div>
      </div>`).join('')}`;

  createModal('mobile-command-sheet', 'More', body, '', true);
}

function openMobileCommandSheet(): void {
  buildMobileCommandSheet();
  showModal('mobile-command-sheet');
}

function runMobileCommand(view: string): void {
  hideModal('mobile-command-sheet');
  showView(view);
}

function openSearchModal(): void {
  if (!state.currentProject) { toast('Select a project first','info'); return; }
  showModal('global-search-modal');
  setTimeout(()=>document.getElementById('global-search-input')?.focus(),50);
}

function globalSearchDebounced(): void {
  clearTimeout(globalSearchTimer);
  globalSearchTimer = setTimeout(doGlobalSearch, 300);
}

async function doGlobalSearch(): Promise<void> {
  const query = (document.getElementById('global-search-input') as HTMLInputElement | null)?.value?.trim();
  if (!query || !state.currentProject) return;
  const resultsEl = document.getElementById('global-search-results');
  if (resultsEl) resultsEl.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div></div>';
  try {
    const data = await api('POST',`/projects/${state.currentProject.id}/pm/search`,{query});
    const results = (data as any).results || (data as any).items || [];
    const { escHtml, typeIcon, priorityDot, statusBadge } = await import('./utils.js');
    if (resultsEl) resultsEl.innerHTML = results.length === 0
      ? `<div class="empty-state" style="padding:24px"><div class="empty-state-text">No results for "${escHtml(query)}"</div></div>`
      : `<div class="item-list">${results.map((item: any)=>`
          <div class="item-row" onclick="window.__app.hideModal('global-search-modal');window.__app.openItemDetail('${escHtml(item.id)}')">
            ${typeIcon(item.type||'')}
            <span class="item-id">${escHtml(item.id)}</span>
            <span class="item-title">${escHtml(item.title)}</span>
            <div class="item-meta">${priorityDot(item.priority||5)}${statusBadge(item.status||'draft')}</div>
          </div>`).join('')}</div>`;
  } catch(err: unknown) {
    if (resultsEl) resultsEl.innerHTML = `<div class="empty-state" style="padding:24px"><div class="empty-state-text">Error: ${err instanceof Error ? err.message : String(err)}</div></div>`;
  }
}

// PWA install
let deferredPrompt: any = null;

// Expose everything needed by inline onclick handlers via window.__app
(window as any).__app = {
  // Views
  showView,
  renderProjectsView,
  renderItemsView,
  renderActivityView,
  renderSearchView,
  renderStatsView,
  renderCalendarView,
  renderContextView,
  renderGraphView,
  renderSharingView,
  renderGroupsView,
  renderHealthView,
  renderDedupeAuditView,
  renderValidateView,
  renderSettingsView,
  renderGitHubView,
  renderExportView,
  renderNormalizeView,
  renderSharedView,
  renderTemplatesView,
  renderCommentsAuditView,
  renderConfigView,
  renderGuideView,
  renderAdminView,

  // Config
  configAddArrayItem,
  configRemoveArrayItem,
  configSaveArray,
  configSaveSimple,
  configSaveObject,
  setAdminRole,

  // Auth
  switchAuthTab,
  submitAuth,
  logout,

  // Projects
  onProjectSelect,
  selectProject,
  deleteProject,
  submitCreateProject,
  submitCreateProject2,

  // Items
  openItemDetail,
  switchDetailTab,
  addComment,
  addNote,
  appendItem,
  updateItem,
  closeItem,
  confirmDeleteItem,
  claimItem,
  releaseItem,
  startItem,
  pauseItem,
  addDep,
  removeDep,
  addLearning,
  addTest,
  addFileLink,
  setStatusFilter,
  applyItemFilters,
  clearFilters,
  showBulkUpdateModal,
  previewBulkUpdate,
  applyBulkUpdate,
  showBulkCloseModal,
  previewBulkClose,
  applyBulkClose,
  useItemAsTemplate,

  // Create
  submitCreateItem,
  submitCreateItemAndOpen,

  // Search
  setSearchMode,
  reindexProject,
  debouncedSearch,
  doSearch,

  // Calendar
  calNav,
  showDayItems,

  // Sharing
  openShareModal,
  submitShare,
  removeShare,

  // Groups
  openCreateGroupModal,
  submitCreateGroup,
  deleteGroup,
  openGroupDetail,
  inviteMember,
  removeMember,

  // Settings
  saveProfile,
  changePassword,
  saveGitHubToken,
  clearGitHubToken,

  // GitHub
  linkGitHubRepo,
  unlinkGitHubRepo,
  loadGitHubIssues,
  selectAllIssues,
  importGitHubIssues,
  loadItemsForPush,
  selectAllPushItems,
  pushItemsToGitHub,
  updateGitHubIssue,

  // Export
  exportData,
  importData,

  // Normalize
  applyNormalize,

  // Templates
  createFromTemplate,

  // Modals
  showModal,
  hideModal,

  // Global search
  openSearchModal,
  globalSearchDebounced,
  openMobileCommandSheet,
  runMobileCommand,

  // Badge
  loadItemsBadge,

  // Toast (used by search.ts)
  toast,

  // SSE
  connectSSE,
  disconnectSSE,

  // Admin
  adminSwitchTab,
  adminDeleteUser,
  adminDeleteProject,
  adminDeleteGroup,
  adminFilterUsers,
  adminFilterProjects,
  adminFilterAudit,
  adminSetPage,
  adminCreateGroup,

  // Graph navigation
  openGraphAt,

  // Plan
  initPlanView,
  openPlanDetail,
  openCreatePlanModal,
  submitCreatePlan,
  openAddStepModal,
  submitAddStep,
  planCompleteStep,
  planBlockStepPrompt,
  submitBlockStep,
  planRemoveStep,
  planApprove,
  planMaterializePrompt,
  submitMaterializePlan,
  planEditPrompt,
  submitEditPlan,
  planDeletePrompt,
};

// ═══════════════════════════════════════════════════════════════
// SSE REAL-TIME SYNC
// ═══════════════════════════════════════════════════════════════
let sseSource: EventSource | null = null;
let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let sseCurrentProjectId: string | null = null;
let sseClientId: string | null = null;

interface PresenceUser {
  userId: string;
  displayName: string;
  currentView: string;
  connectedAt: string;
}

function userInitials(displayName: string): string {
  return displayName
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

function renderPresenceBar(users: PresenceUser[]): void {
  const bar = document.getElementById('presence-bar');
  if (!bar) return;
  const myId = state.user?.id;
  // Show other users; if only me, hide the bar
  const others = users.filter((u) => u.userId !== myId);
  if (others.length === 0) {
    bar.innerHTML = '';
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  const MAX_VISIBLE = 5;
  const visible = others.slice(0, MAX_VISIBLE);
  const extra = others.length - MAX_VISIBLE;

  const chips = visible.map((u) => {
    const initials = userInitials(u.displayName);
    const hue = Math.abs(u.userId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)) % 360;
    const color = `hsl(${hue},60%,55%)`;
    const viewLabel = u.currentView.replace(/-/g, ' ');
    return `<div class="presence-chip" title="${escHtml(u.displayName)} · ${escHtml(viewLabel)}" style="background:${color}22;border-color:${color}66;color:${color}">${escHtml(initials)}</div>`;
  }).join('');

  const extraChip = extra > 0
    ? `<div class="presence-chip presence-chip-extra" title="${extra} more user${extra > 1 ? 's' : ''} viewing">+${extra}</div>`
    : '';

  bar.innerHTML = `<span class="presence-label">Viewing:</span>${chips}${extraChip}`;
}

function setSseStatus(status: 'connected' | 'disconnected' | 'reconnecting'): void {
  const el = document.getElementById('sse-indicator');
  if (!el) return;
  el.classList.remove('connected', 'reconnecting');
  if (status === 'connected') {
    el.classList.add('connected');
    el.title = 'Real-time sync connected';
  } else if (status === 'reconnecting') {
    el.classList.add('reconnecting');
    el.title = 'Real-time sync reconnecting…';
  } else {
    el.title = 'Real-time sync disconnected';
    // Clear presence bar on disconnect
    const bar = document.getElementById('presence-bar');
    if (bar) { bar.innerHTML = ''; bar.style.display = 'none'; }
  }
}

function disconnectSSE(): void {
  if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
  if (sseSource) { sseSource.close(); sseSource = null; }
  sseCurrentProjectId = null;
  sseClientId = null;
  setSseStatus('disconnected');
}

function notifyPresenceView(view: string): void {
  if (!sseClientId || !sseCurrentProjectId) return;
  // Fire-and-forget: update current view on server
  void fetch(`/api/projects/${encodeURIComponent(sseCurrentProjectId)}/pm/presence/${encodeURIComponent(sseClientId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ view }),
  }).catch(() => undefined);
}

function connectSSE(projectId: string, attempt = 0): void {
  if (sseCurrentProjectId === projectId && sseSource && sseSource.readyState !== EventSource.CLOSED) return;
  disconnectSSE();
  sseCurrentProjectId = projectId;
  setSseStatus(attempt > 0 ? 'reconnecting' : 'disconnected');

  const u = state.user;
  const displayName = encodeURIComponent(u?.display_name || u?.email || '');
  const currentView = encodeURIComponent(state.currentView || 'items');
  const url = `/api/projects/${encodeURIComponent(projectId)}/pm/events?dn=${displayName}&view=${currentView}`;
  try {
    const source = new EventSource(url);
    sseSource = source;

    source.addEventListener('connected', (evt: MessageEvent) => {
      setSseStatus('connected');
      try {
        const data = JSON.parse(evt.data) as { clientId?: string };
        if (data.clientId) sseClientId = data.clientId;
      } catch { /* ignore */ }
    });

    // Handle presence updates
    source.addEventListener('presence', (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data) as { users: PresenceUser[] };
        renderPresenceBar(data.users);
      } catch { /* ignore */ }
    });

    // Handle item updates — refresh the current view
    const refreshView = () => {
      const view = state.currentView;
      if (view === 'items') {
        fetchAndRenderItems();
      } else if (view === 'activity') {
        renderActivityView();
      } else if (view === 'stats') {
        renderStatsView();
      } else if (view === 'plan') {
        initPlanView();
      }
      loadItemsBadge();
    };

    // Graph-synced events (Neo4j sync complete) do a full graph reload
    const refreshGraph = () => {
      if (state.currentView === 'graph') {
        import('./views/graph.js').then((module) => module.renderGraphView());
      }
    };

    // Item events on graph view use lightweight data-only refresh
    const refreshGraphData = () => {
      if (state.currentView === 'graph') {
        import('./views/graph.js').then((module) => module.refreshGraphData());
      } else {
        refreshView();
      }
    };
    const graphSyncFailed = (evt: MessageEvent) => {
      let reason = '';
      let detail = '';
      try {
        const payload = JSON.parse(evt.data) as { reason?: string; error?: string };
        reason = payload.reason || '';
        detail = payload.error || '';
      } catch {
        detail = evt.data;
      }
      const message = detail
        ? `Graph sync failed${reason ? ` (${reason})` : ''}: ${detail}`
        : `Graph sync failed${reason ? ` (${reason})` : ''}`;
      toast(message, 'error');
    };

    source.addEventListener('item-created', refreshGraphData);
    source.addEventListener('item-updated', refreshGraphData);
    source.addEventListener('dependency-added', refreshGraphData);
    source.addEventListener('dependency-removed', refreshGraphData);
    source.addEventListener('dependency_added', refreshGraphData);
    source.addEventListener('dependency_removed', refreshGraphData);
    source.addEventListener('items-imported', refreshGraphData);
    source.addEventListener('items-bulk-updated', refreshGraphData);
    source.addEventListener('item-closed', refreshGraphData);
    source.addEventListener('item-deleted', refreshGraphData);
    source.addEventListener('graph-synced', refreshGraph);
    source.addEventListener('item_created', refreshGraphData);
    source.addEventListener('item_updated', refreshGraphData);
    source.addEventListener('item_bulk_updated', refreshGraphData);
    source.addEventListener('item_closed', refreshGraphData);
    source.addEventListener('item_deleted', refreshGraphData);
    source.addEventListener('graph_synced', refreshGraph);
    source.addEventListener('graph-sync-failed', graphSyncFailed);
    source.addEventListener('graph_sync_failed', graphSyncFailed);
    source.addEventListener('update', refreshView);

    source.onerror = () => {
      setSseStatus('reconnecting');
      source.close();
      sseSource = null;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      sseReconnectTimer = setTimeout(() => connectSSE(projectId, attempt + 1), delay);
    };
  } catch {
    // EventSource not supported or URL invalid
    setSseStatus('disconnected');
  }
}

export { connectSSE, disconnectSSE, notifyPresenceView };

// ═══════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════
export async function bootApp(): Promise<void> {
  const authScreen = document.getElementById('auth-screen');
  const mainApp = document.getElementById('main-app');
  if (authScreen) authScreen.style.display = 'none';
  if (mainApp) mainApp.style.display = 'flex';

  const u = state.user!;
  const initials = (u.display_name||u.email||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const avatarEl = document.getElementById('user-avatar');
  if (avatarEl) avatarEl.textContent = initials;
  const nameEl = document.getElementById('user-name-display');
  if (nameEl) nameEl.textContent = u.display_name||u.email;
  document.querySelectorAll<HTMLElement>('.admin-only').forEach((el) => {
    el.style.display = u.is_admin ? '' : 'none';
  });

  buildCreateProjectModal();
  buildSearchModal();
  buildMobileCommandSheet();

  // Wire up presence view-change notifications
  setOnViewChange((view) => notifyPresenceView(view));

  await loadProjects();
  await handleLaunchAction();
}

async function handleLaunchAction(): Promise<void> {
  const action = new URLSearchParams(window.location.search).get('action');

    if (action === 'new-project') {
    showView('projects');
    showModal('create-project-modal');
    setTimeout(() => document.getElementById('cp-name')?.focus(), 50);
    return;
  }

  if (action === 'new-item' || action === 'search') {
    if (!state.currentProject && state.projects[0]) {
      await onProjectSelect(state.projects[0].id);
    }
    if (!state.currentProject) {
      showView('projects');
      toast('Create a project first', 'info');
      return;
    }
    showView(action === 'new-item' ? 'create' : 'search');
    if (action === 'search') {
      setTimeout(() => document.getElementById('search-query')?.focus(), 100);
    }
    return;
  }

  // Restore view from URL path (supports refresh/bookmark)
  const { getViewForPath } = await import('./views/router.js');
  const view = getViewForPath(window.location.pathname);

  // If view requires a project and none is selected, try to select first one
  const projectRequired = view !== 'projects' && view !== 'settings' && view !== 'admin' && view !== 'shared' && view !== 'groups' && view !== 'guide';
  if (projectRequired && !state.currentProject && state.projects[0]) {
    await onProjectSelect(state.projects[0].id);
  }
  if (view === 'admin' && !state.user?.is_admin) {
    history.replaceState({ view: 'projects' }, '', '/');
    toast('Admin access is required to open this view', 'error');
    showView('projects');
    return;
  }
  if (projectRequired && !state.currentProject) {
    showView('projects');
    toast('Select a project first', 'info');
    return;
  }

  // Replace current history state so back/forward works properly
  history.replaceState({ view }, '', window.location.pathname);
  showView(view, false);
}

// ═══════════════════════════════════════════════════════════════
// GLOBAL ERROR BOUNDARY
// ═══════════════════════════════════════════════════════════════
function showGlobalError(errorMsg: string, error?: unknown): void {
  const appEl = document.getElementById('app');
  if (!appEl) return;

  // Hide other screens
  const authScreen = document.getElementById('auth-screen');
  const mainApp = document.getElementById('main-app');
  if (authScreen) authScreen.style.display = 'none';
  if (mainApp) mainApp.style.display = 'none';

  // Create or update error screen
  let errorScreen = document.getElementById('global-error-screen');
  if (!errorScreen) {
    errorScreen = document.createElement('div');
    errorScreen.id = 'global-error-screen';
    errorScreen.setAttribute('role', 'alert');
    errorScreen.setAttribute('aria-live', 'assertive');
    appEl.appendChild(errorScreen);
  }

  const stackTrace = error instanceof Error && error.stack
    ? `<details style="margin-top:12px;text-align:left"><summary style="cursor:pointer;color:var(--text-muted);font-size:12px">Stack trace</summary><pre style="margin-top:8px;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted);white-space:pre-wrap;word-break:break-all">${escHtml(error.stack)}</pre></details>`
    : '';

  errorScreen.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:40px;text-align:center">
      <div style="font-size:48px;margin-bottom:20px;opacity:0.5">⚠</div>
      <h1 style="font-size:22px;font-weight:600;margin-bottom:8px">Something went wrong</h1>
      <p style="color:var(--text-secondary);max-width:480px;line-height:1.7;margin-bottom:8px">${escHtml(errorMsg)}</p>
      ${stackTrace}
      <div style="display:flex;gap:12px;margin-top:24px;flex-wrap:wrap;justify-content:center">
        <button class="btn btn-primary" onclick="location.reload()" aria-label="Reload the page">Reload Page</button>
        <button class="btn btn-secondary" onclick="document.getElementById('global-error-screen').remove();document.getElementById('auth-screen').style.display='flex'" aria-label="Go to login screen">Go to Login</button>
        <button class="btn btn-ghost" onclick="navigator.clipboard.writeText(this.closest('[role=alert]').innerText);window.__app.toast('Error details copied','success')" aria-label="Copy error details">Copy Details</button>
      </div>
    </div>`;
}

// Global error handlers
window.addEventListener('error', (event: ErrorEvent) => {
  console.error('Global error:', event.error);
  // Don't show for script load failures that are likely network issues
  if (event.message && !event.message.includes('Load failed') && !event.message.includes('error loading dynamically imported module')) {
    showGlobalError(event.message || 'An unexpected error occurred', event.error);
  }
  event.preventDefault();
});

window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  console.error('Unhandled promise rejection:', event.reason);
  const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
  // Don't show for network/import errors during normal operation
  if (!msg.includes('Load failed') && !msg.includes('error loading dynamically imported module') && !msg.includes('Failed to fetch')) {
    showGlobalError(msg, event.reason instanceof Error ? event.reason : undefined);
  }
  event.preventDefault();
});

async function init(): Promise<void> {
  try {
    const data = await api('GET','/auth/me');
    state.user = (data as any).user;
    await bootApp();
  } catch(_) {
    showAuth();
  }
}

// ═══════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════════
let lastKeyTime = 0;
let lastKey = '';

function openShortcutsHelp(): void {
  createModal('shortcuts-help-modal', 'Keyboard Shortcuts', `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tbody>
        ${[
          ['?', 'Show this shortcuts help'],
          ['Ctrl+K', 'Open global search'],
          ['/', 'Focus search (from any view)'],
          ['Esc', 'Close modal / go back'],
          ['n / c', 'Create new item'],
          ['a', 'Go to Activity view'],
          ['g i', 'Go to Items view'],
          ['g g', 'Go to Graph view'],
          ['g s', 'Go to Search view'],
          ['g c', 'Go to Calendar view'],
        ].map(([key, desc]) => `
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:8px 12px 8px 0;white-space:nowrap"><kbd style="font-family:'JetBrains Mono',monospace;font-size:12px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;padding:2px 6px;color:var(--accent)">${escHtml(key)}</kbd></td>
            <td style="padding:8px 0;color:var(--text-secondary)">${escHtml(desc)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`, '');
  showModal('shortcuts-help-modal');
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    if (state.user) openSearchModal();
  }
  if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'SELECT') return;

  // Multi-key sequences (e.g. g i, g g)
  const now = Date.now();
  if (lastKey === 'g' && now - lastKeyTime < 1500) {
    if (e.key === 'i') { e.preventDefault(); if (state.currentProject) showView('items'); lastKey = ''; return; }
    if (e.key === 'g') { e.preventDefault(); if (state.currentProject) showView('graph'); lastKey = ''; return; }
    if (e.key === 's') { e.preventDefault(); if (state.currentProject) showView('search'); lastKey = ''; return; }
    if (e.key === 'c') { e.preventDefault(); if (state.currentProject) showView('calendar'); lastKey = ''; return; }
  }
  lastKey = e.key;
  lastKeyTime = now;

  if (e.key === '?') { e.preventDefault(); if (state.user) openShortcutsHelp(); }
  if (e.key === 'n' || e.key === 'N') { if (state.currentProject) showView('create'); }
  if (e.key === 'c' || e.key === 'C') { if (state.currentProject) showView('create'); }
  if (e.key === 'a' || e.key === 'A') { if (state.currentProject) showView('activity'); }
  if (e.key === '/') { e.preventDefault(); if (state.currentProject) { showView('search'); setTimeout(()=>document.getElementById('search-query')?.focus(), 100); } }
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-backdrop').forEach(m => { (m as HTMLElement).style.display='none'; });
  }
});

// ═══════════════════════════════════════════════════════════════
// PWA INSTALL PROMPT
// ═══════════════════════════════════════════════════════════════
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const banner = document.getElementById('install-banner');
  if (banner && !localStorage.getItem('pm-web-install-dismissed')) {
    banner.classList.add('visible');
  }
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  const banner = document.getElementById('install-banner');
  if (banner) banner.classList.remove('visible');
  toast('pm-web installed!', 'success');
});

(window as any).installPwa = function(): void {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then((result: { outcome: string }) => {
    if (result.outcome === 'accepted') {
      toast('Installing pm-web...', 'success');
    }
    deferredPrompt = null;
    const banner = document.getElementById('install-banner');
    if (banner) banner.classList.remove('visible');
  });
};

(window as any).dismissInstallBanner = function(): void {
  localStorage.setItem('pm-web-install-dismissed', '1');
  const banner = document.getElementById('install-banner');
  if (banner) banner.classList.remove('visible');
};

// ═══════════════════════════════════════════════════════════════
// OFFLINE / ONLINE STATUS BANNER
// ═══════════════════════════════════════════════════════════════
function updateOfflineBanner(): void {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  if (!navigator.onLine) {
    banner.classList.add('visible');
  } else {
    banner.classList.remove('visible');
  }
}

window.addEventListener('offline', updateOfflineBanner);
window.addEventListener('online', () => {
  updateOfflineBanner();
  toast('Back online — syncing…', 'success');
});

// Set initial state
updateOfflineBanner();

// ═══════════════════════════════════════════════════════════════
// PULL TO REFRESH (mobile)
// ═══════════════════════════════════════════════════════════════
(function() {
  let startY = 0, pulling = false;
  const threshold = 80;

  document.addEventListener('touchstart', e => {
    const mc = document.getElementById('main-content');
    if (!mc || mc.scrollTop > 0) return;
    startY = e.touches[0].pageY;
    pulling = true;
  }, {passive: true});

  document.addEventListener('touchmove', _e => {
    if (!pulling) return;
  }, {passive: true});

  document.addEventListener('touchend', e => {
    if (!pulling) return;
    const diff = (e.changedTouches[0]?.pageY || 0) - startY;
    pulling = false;
    if (diff > threshold && state.currentProject) {
      const view = state.currentView;
      if (showView) showView(view);
      toast('Refreshed', 'info');
    }
  }, {passive: true});
})();

// ═══════════════════════════════════════════════════════════════
// SERVICE WORKER
// ═══════════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js?v=8', { updateViaCache: 'none' }).catch(() => {/* silent */});
  });
}

// Start the app
init();
