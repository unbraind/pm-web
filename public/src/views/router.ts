// ═══════════════════════════════════════════════════════════════
// ROUTER — View switching with URL routing
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { VIEW_NAMES } from '../constants.js';
import { renderProjectsView } from './projects.js';
import { renderItemsView } from './items.js';
import { renderCreateView } from './create.js';
import { renderActivityView } from './activity.js';
import { renderSearchView } from './search.js';
import { renderStatsView } from './stats.js';
import { renderCalendarView } from './calendar.js';
import { renderContextView } from './context.js';
import { renderGraphView } from './graph.js';
import { renderSharingView } from './sharing.js';
import { renderGroupsView } from './groups.js';
import { renderHealthView } from './health.js';
import { renderDedupeAuditView } from './dedupe.js';
import { renderValidateView } from './validate.js';
import { renderSettingsView } from './settings.js';
import { renderGitHubView } from './github.js';
import { renderExportView } from './export.js';
import { renderNormalizeView } from './normalize.js';
import { renderSharedView } from './shared.js';
import { renderTemplatesView } from './templates.js';
import { renderCommentsAuditView } from './comments-audit.js';
import { renderConfigView } from './config.js';
import { renderGuideView } from './guide.js';
import { renderAdminView } from './admin.js';

// View name → URL path mapping
const VIEW_TO_PATH: Record<string, string> = {
  'projects': '/',
  'items': '/items',
  'create': '/create',
  'activity': '/activity',
  'search': '/search',
  'stats': '/stats',
  'calendar': '/calendar',
  'context': '/context',
  'graph': '/graph',
  'sharing': '/sharing',
  'groups': '/groups',
  'health': '/health',
  'dedupe': '/dedupe',
  'validate': '/validate',
  'settings': '/settings',
  'github': '/github',
  'export': '/export',
  'normalize': '/normalize',
  'shared': '/shared',
  'templates': '/templates',
  'comments-audit': '/comments-audit',
  'config': '/config',
  'guide': '/guide',
  'admin': '/admin',
};

// Reverse: URL path → view name
const PATH_TO_VIEW: Record<string, string> = {};
for (const [view, path] of Object.entries(VIEW_TO_PATH)) {
  PATH_TO_VIEW[path] = view;
}

// Whether pushState was just called (to ignore the resulting popstate)
let navigatingInternally = false;

export function getPathForView(view: string): string {
  return VIEW_TO_PATH[view] || '/';
}

export function getViewForPath(path: string): string {
  // Normalize: remove trailing slash except for root
  const normalized = path.replace(/\/$/, '') || '/';
  // Direct match
  if (PATH_TO_VIEW[normalized]) return PATH_TO_VIEW[normalized];
  // Try matching first segment for deeper paths (e.g. /items/DETAIL-1 → items)
  const firstSegment = '/' + normalized.slice(1).split('/')[0];
  return PATH_TO_VIEW[firstSegment] || 'projects';
}

export function showView(view: string, pushState = true): void {
  state.currentView = view;

  // Update URL via pushState
  if (pushState) {
    const path = getPathForView(view);
    if (window.location.pathname !== path) {
      navigatingInternally = true;
      history.pushState({ view }, '', path);
    }
  }

  // Full-screen graph mode: hide sidebar
  document.body.classList.toggle('graph-mode', view === 'graph');
  VIEW_NAMES.forEach(v => {
    const el = document.getElementById(`content-${v}`);
    if (el) el.style.display = v === view ? '' : 'none';
  });
  document.querySelectorAll('.sidebar-item[data-view]').forEach(el => {
    (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.view === view);
  });
  if (view === 'projects') {
    document.querySelectorAll('#sidebar-projects-section .sidebar-item').forEach((el,i) => {
      (el as HTMLElement).classList.toggle('active', i===0);
    });
  }
  switch(view) {
    case 'projects': renderProjectsView(); break;
    case 'items': renderItemsView(); break;
    case 'create': renderCreateView(); break;
    case 'activity': renderActivityView(); break;
    case 'search': renderSearchView(); break;
    case 'stats': renderStatsView(); break;
    case 'calendar': renderCalendarView(); break;
    case 'context': renderContextView(); break;
    case 'graph': renderGraphView(); break;
    case 'sharing': renderSharingView(); break;
    case 'groups': renderGroupsView(); break;
    case 'health': renderHealthView(); break;
    case 'dedupe': renderDedupeAuditView(); break;
    case 'validate': renderValidateView(); break;
    case 'settings': renderSettingsView(); break;
    case 'github': renderGitHubView(); break;
    case 'export': renderExportView(); break;
    case 'normalize': renderNormalizeView(); break;
    case 'shared': renderSharedView(); break;
    case 'templates': renderTemplatesView(); break;
    case 'comments-audit': renderCommentsAuditView(); break;
    case 'config': renderConfigView(); break;
    case 'guide': renderGuideView(); break;
    case 'admin': renderAdminView(); break;
  }
  updateMobileNav(view);

  // Scroll main content to top on view change
  const mainContent = document.getElementById('main-content');
  if (mainContent) mainContent.scrollTop = 0;

  // Move focus to main content for accessibility
  const activeArea = document.getElementById(`content-${view}`);
  if (activeArea) {
    activeArea.setAttribute('tabindex', '-1');
    activeArea.focus({ preventScroll: true });
  }
}

function updateMobileNav(view: string): void {
  document.querySelectorAll('.mobile-bottom-nav-item').forEach(el => {
    (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.mobview === view);
  });
  const nav = document.getElementById('mobile-bottom-nav');
  if (nav) {
    nav.classList.toggle('visible', !!state.currentProject && view !== 'projects');
  }
}

// Handle browser back/forward
function onPopState(e: PopStateEvent): void {
  // Ignore if we just pushed state (some browsers fire popstate after pushState)
  if (navigatingInternally) {
    navigatingInternally = false;
    return;
  }
  const view = e.state?.view || getViewForPath(window.location.pathname);
  showView(view, false);
}

// Initialize popstate listener
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', onPopState);
}
