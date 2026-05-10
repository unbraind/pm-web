// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface User {
  id: string;
  email: string;
  display_name?: string;
  has_github_token?: boolean;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  prefix: string;
  description?: string;
  created_at: string;
  updated_at?: string;
}

export interface Item {
  id: string;
  title: string;
  type?: string;
  status?: string;
  priority?: number;
  description?: string;
  body?: string;
  tags?: string[];
  parent?: string;
  deadline?: string;
  assignee?: string;
  sprint?: string;
  release?: string;
  estimated_minutes?: number;
  acceptance_criteria?: string;
  acceptanceCriteria?: string;
  claimedBy?: string;
  created_at?: string;
  updated_at?: string;
  reporter?: string;
  component?: string;
  severity?: string;
  risk?: string;
  goal?: string;
  environment?: string;
  blockedBy?: string;
  blockedReason?: string;
  reproSteps?: string;
  expectedResult?: string;
  'blocked-by'?: string;
  'blocked-reason'?: string;
  'repro-steps'?: string;
  'expected-result'?: string;
}

export interface Comment {
  text?: string;
  content?: string;
  body?: string;
  timestamp?: string;
  created_at?: string;
}

export interface HistoryEntry {
  message?: string;
  action?: string;
  timestamp?: string;
  created_at?: string;
}

export interface Dependency {
  targetId?: string;
  id?: string;
  rel?: string;
  relationship?: string;
  targetTitle?: string;
  title?: string;
}

export interface Learning {
  text?: string;
  content?: string;
  timestamp?: string;
  created_at?: string;
}

export interface Note {
  text?: string;
  content?: string;
  timestamp?: string;
  created_at?: string;
}

export interface TestEntry {
  command?: string;
  cmd?: string;
  description?: string;
}

export interface FileEntry {
  path?: string;
  name?: string;
  scope?: string;
}

export interface Share {
  id?: string;
  shareId?: string;
  email?: string;
  groupName?: string;
  groupId?: string;
  userId?: string;
  permission?: string;
}

export interface Group {
  id: string;
  name: string;
  description?: string;
  members?: GroupMember[];
  memberCount?: number;
}

export interface GroupMember {
  id?: string;
  userId?: string;
  displayName?: string;
  email?: string;
}

export interface Stats {
  total?: number;
  byStatus?: Record<string, number>;
  byType?: Record<string, number>;
}

export interface HealthData {
  score?: number;
  issues?: Array<{ message?: string; description?: string }>;
  summary?: string;
}

export interface ItemFilters {
  status: string;
  type: string;
  priority: string;
  sprint: string;
  release: string;
  assignee: string;
}

export interface AppState {
  user: User | null;
  projects: Project[];
  currentProject: Project | null;
  currentView: string;
  authTab: string;
  items: Item[];
  itemFilters: ItemFilters;
  searchQuery: string;
  searchResults: Item[];
  searchMode: string;
  calOffset: number;
}

export type ToastType = 'info' | 'success' | 'error';

export type ViewName =
  | 'projects' | 'items' | 'create' | 'activity' | 'search'
  | 'stats' | 'calendar' | 'context' | 'sharing' | 'groups'
  | 'health' | 'dedupe' | 'validate' | 'settings' | 'github'
  | 'export' | 'normalize' | 'shared' | 'templates' | 'comments-audit'
  | 'config';
