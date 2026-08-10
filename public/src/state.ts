// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════
import type { AppState } from './types.js';

/** Mutable singleton holding the SPA's global application state: the signed-in
 * user, loaded projects, the active project and view, item list and filters,
 * and search state. Views read and mutate this directly. */
export const state: AppState = {
  user: null,
  projects: [],
  currentProject: null,
  currentView: 'projects',
  authTab: 'login',
  items: [],
  itemFilters: { status: '', type: '', priority: '', sprint: '', release: '', assignee: '', tag: '' },
  searchQuery: '',
  searchResults: [],
  searchMode: 'hybrid',
  calOffset: 0,
  schema: null,
};
