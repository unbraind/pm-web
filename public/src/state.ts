// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════
import type { AppState } from './types.js';

export const state: AppState = {
  user: null,
  projects: [],
  currentProject: null,
  currentView: 'projects',
  authTab: 'login',
  items: [],
  itemFilters: { status: '', type: '', priority: '', sprint: '', release: '', assignee: '' },
  searchQuery: '',
  searchResults: [],
  searchMode: 'hybrid',
  calOffset: 0,
};
