// ═══════════════════════════════════════════════════════════════
// ROUTER — View switching
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

export function showView(view: string): void {
  state.currentView = view;
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
