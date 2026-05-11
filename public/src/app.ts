// ═══════════════════════════════════════════════════════════════
// APP — Main entry point
// ═══════════════════════════════════════════════════════════════
import { state } from './state.js';
import { api } from './api.js';
import { showView } from './views/router.js';
import { loadProjects, onProjectSelect, loadItemsBadge, renderProjectsView, selectProject, deleteProject, buildCreateProjectModal, submitCreateProject, submitCreateProject2 } from './views/projects.js';
import { renderItemsView, fetchAndRenderItems, openItemDetail, switchDetailTab, addComment, addNote, appendItem, updateItem, closeItem, confirmDeleteItem, claimItem, releaseItem, startItem, pauseItem, addDep, addLearning, addTest, addFileLink, setStatusFilter, applyItemFilters, clearFilters, showBulkUpdateModal, previewBulkUpdate, applyBulkUpdate } from './views/items.js';
import { submitCreateItem, submitCreateItemAndOpen } from './views/create.js';
import { renderActivityView } from './views/activity.js';
import { renderSearchView, setSearchMode, reindexProject, debouncedSearch, doSearch } from './views/search.js';
import { renderStatsView } from './views/stats.js';
import { renderCalendarView, calNav, showDayItems } from './views/calendar.js';
import { renderContextView } from './views/context.js';
import { renderGraphView } from './views/graph.js';
import { renderSharingView, openShareModal, submitShare, removeShare } from './views/sharing.js';
import { renderGroupsView, openCreateGroupModal, submitCreateGroup, deleteGroup, openGroupDetail, inviteMember, removeMember } from './views/groups.js';
import { renderHealthView } from './views/health.js';
import { renderDedupeAuditView } from './views/dedupe.js';
import { renderValidateView } from './views/validate.js';
import { renderSettingsView, saveProfile, changePassword, saveGitHubToken, clearGitHubToken } from './views/settings.js';
import { renderGitHubView, linkGitHubRepo, unlinkGitHubRepo, loadGitHubIssues, selectAllIssues, importGitHubIssues } from './views/github.js';
import { renderExportView, exportData, importData } from './views/export.js';
import { renderNormalizeView, applyNormalize } from './views/normalize.js';
import { renderSharedView } from './views/shared.js';
import { renderTemplatesView, createFromTemplate } from './views/templates.js';
import { renderCommentsAuditView } from './views/comments-audit.js';
import { renderConfigView, configAddArrayItem, configRemoveArrayItem, configSaveArray, configSaveSimple, configSaveObject } from './views/config.js';
import { renderGuideView } from './views/guide.js';
import { renderAdminView, setAdminRole } from './views/admin.js';
import { switchAuthTab, submitAuth, logout, showAuth } from './views/auth.js';
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
  addLearning,
  addTest,
  addFileLink,
  setStatusFilter,
  applyItemFilters,
  clearFilters,
  showBulkUpdateModal,
  previewBulkUpdate,
  applyBulkUpdate,

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
};

// ═══════════════════════════════════════════════════════════════
// SSE REAL-TIME SYNC
// ═══════════════════════════════════════════════════════════════
let sseSource: EventSource | null = null;
let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let sseCurrentProjectId: string | null = null;

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
  }
}

function disconnectSSE(): void {
  if (sseReconnectTimer) { clearTimeout(sseReconnectTimer); sseReconnectTimer = null; }
  if (sseSource) { sseSource.close(); sseSource = null; }
  sseCurrentProjectId = null;
  setSseStatus('disconnected');
}

function connectSSE(projectId: string, attempt = 0): void {
  if (sseCurrentProjectId === projectId && sseSource && sseSource.readyState !== EventSource.CLOSED) return;
  disconnectSSE();
  sseCurrentProjectId = projectId;
  setSseStatus(attempt > 0 ? 'reconnecting' : 'disconnected');

  const url = `/api/projects/${encodeURIComponent(projectId)}/pm/events`;
  try {
    const source = new EventSource(url);
    sseSource = source;

    source.addEventListener('connected', () => {
      setSseStatus('connected');
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
      } else if (view === 'graph') {
        import('./views/graph.js').then((module) => module.renderGraphView());
      }
      loadItemsBadge();
    };

    source.addEventListener('item-created', refreshView);
    source.addEventListener('item-updated', refreshView);
    source.addEventListener('item-closed', refreshView);
    source.addEventListener('item-deleted', refreshView);
    source.addEventListener('graph-synced', refreshView);
    source.addEventListener('item_created', refreshView);
    source.addEventListener('item_updated', refreshView);
    source.addEventListener('item_closed', refreshView);
    source.addEventListener('item_deleted', refreshView);
    source.addEventListener('graph_synced', refreshView);
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

export { connectSSE, disconnectSSE };

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

  showView('projects');
}

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
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    if (state.user) openSearchModal();
  }
  if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'SELECT') return;
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
    navigator.serviceWorker.register('/sw.js?v=4', { updateViaCache: 'none' }).catch(() => {/* silent */});
  });
}

// Start the app
init();
