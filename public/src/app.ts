// ═══════════════════════════════════════════════════════════════
// APP — Main entry point
// ═══════════════════════════════════════════════════════════════
import { state } from './state.js';
import { api } from './api.js';
import { showView } from './views/router.js';
import { loadProjects, onProjectSelect, loadItemsBadge, renderProjectsView, selectProject, deleteProject, buildCreateProjectModal, submitCreateProject } from './views/projects.js';
import { renderItemsView, fetchAndRenderItems, openItemDetail, switchDetailTab, addComment, addNote, appendItem, updateItem, closeItem, confirmDeleteItem, claimItem, releaseItem, startItem, pauseItem, addDep, addLearning, addTest, addFileLink, setStatusFilter, applyItemFilters, clearFilters, showBulkUpdateModal, previewBulkUpdate, applyBulkUpdate } from './views/items.js';
import { submitCreateItem, submitCreateItemAndOpen } from './views/create.js';
import { renderActivityView } from './views/activity.js';
import { renderSearchView, setSearchMode, reindexProject, debouncedSearch, doSearch } from './views/search.js';
import { renderStatsView } from './views/stats.js';
import { renderCalendarView, calNav, showDayItems } from './views/calendar.js';
import { renderContextView } from './views/context.js';
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
import { switchAuthTab, submitAuth, logout, showAuth } from './views/auth.js';
import { showModal, hideModal, createModal, closeAllModals } from './components/modals.js';
import { toast } from './components/toast.js';

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

  // Auth
  switchAuthTab,
  submitAuth,
  logout,

  // Projects
  onProjectSelect,
  selectProject,
  deleteProject,
  submitCreateProject,

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
      }
      loadItemsBadge();
    };

    source.addEventListener('item_created', refreshView);
    source.addEventListener('item_updated', refreshView);
    source.addEventListener('item_closed', refreshView);
    source.addEventListener('item_deleted', refreshView);
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

  buildCreateProjectModal();
  buildSearchModal();

  await loadProjects();
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
    navigator.serviceWorker.register('/sw.js').catch(() => {/* silent */});
  });
}

// Start the app
init();
