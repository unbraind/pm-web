// ═══════════════════════════════════════════════════════════════
// API RESPONSE TYPES
// ═══════════════════════════════════════════════════════════════
//
// Response shapes for the browser client (`public/src`) typed against what the
// server routes in `src/routes/` actually return from their `res.json(...)`
// calls. Domain entities are reused from `types.ts` (`Item`, `Project`,
// `User`, `Comment`, `HistoryEntry`, `Note`, `TestEntry`, `FileEntry`,
// `Learning`, `Stats`, `HealthData`, `Group`, `Share`, …) rather than
// redeclared here.
//
// Several pm-CLI-backed routes answer with `res.json(result.parsed || { … })`,
// so the happy-path fields mirror the pm CLI's JSON output and every field is
// optional where the server may legitimately omit it (or answer with an
// `{ error }` envelope on failure).

import type {
  Comment,
  FileEntry,
  Group,
  HealthData,
  HealthIssue,
  HistoryEntry,
  Item,
  Learning,
  Note,
  Project,
  ProjectSchema,
  Share,
  Stats,
  TestEntry,
  User,
} from './types.js';

/** Response from `GET /api/auth/me` — see src/routes/auth.ts. */
export interface AuthMeResponse {
  user: User;
}

/** Response from `PATCH /api/auth/profile` — see src/routes/auth.ts. */
export interface ProfileResponse {
  user: User;
}

/** Response from `PATCH /api/auth/github-token` — see src/routes/auth.ts. */
export interface GithubTokenResponse {
  ok: boolean;
  hasToken: boolean;
}

/** Response from `GET /api/projects` and `GET /api/projects/:id` — see src/routes/projects.ts. */
export interface ProjectRow extends Project {
  /** Whether the requesting user owns the project (server alias `is_owner`). */
  is_owner?: boolean;
  /** `"edit"` or `"view"` — the caller's permission on this project. */
  permission?: string;
}

/** Response from `GET /api/projects` — see src/routes/projects.ts. */
export interface ProjectsResponse {
  projects: ProjectRow[];
}

/** Response from `POST /api/projects` — see src/routes/projects.ts. */
export interface CreateProjectResponse {
  project: Project;
}

/** Response from `GET /api/projects/:id/shares` — see src/routes/sharing.ts. */
export interface ShareRow extends Share {
  user_id?: string;
  user_email?: string;
  user_display_name?: string;
  userDisplayName?: string;
  group_id?: string;
  group_name?: string;
  shared_at?: string;
}

/** Response from `GET /api/projects/:id/shares` — see src/routes/sharing.ts. */
export interface SharesResponse {
  shares: ShareRow[];
}

/** Response from `GET /api/shared` — see src/routes/sharing.ts. */
export interface SharedProject extends Project {
  owner_id?: string;
  owner_email?: string;
  owner_display_name?: string;
  permission?: string;
  shared_at?: string;
}

/** Response from `GET /api/shared` — see src/routes/sharing.ts. */
export interface SharedProjectsResponse {
  projects: SharedProject[];
}

/** A group row as returned by `GET /api/groups` — see src/routes/groups.ts. */
export interface GroupListRow {
  id: string;
  owner_id?: string;
  name: string;
  description?: string;
  /** COUNT(*) of members, aliased `member_count` by the server. */
  member_count: number;
  role?: string;
  created_at?: string;
  updated_at?: string;
}

/** Response from `GET /api/groups` — see src/routes/groups.ts. */
export interface GroupsResponse {
  groups: GroupListRow[];
}

/** A member row as returned by `GET /api/groups/:id` — see src/routes/groups.ts. */
export interface GroupMemberRow {
  id?: string;
  user_id?: string;
 userId?: string;
  role?: string;
  invited_at?: string;
  email?: string;
  display_name?: string;
  displayName?: string;
}

/** Response from `GET /api/groups/:id` — see src/routes/groups.ts. */
export interface GroupDetailResponse {
  group: Group & { members: GroupMemberRow[]; owner_id?: string };
}

/** Response from `GET /api/projects/:id/pm/schema` — see src/routes/pm.ts. */
export type SchemaResponse = ProjectSchema;

/** Common list envelope for `pm list` / `pm list-all` — see src/routes/pm.ts. */
export interface ListResponse {
  items: Item[];
  error?: string;
  [key: string]: unknown;
}

/** Response from `POST /api/projects/:id/pm/create` — see src/routes/pm.ts. */
export interface CreateItemResponse {
  item?: { id?: string };
  id?: string;
  error?: string;
  [key: string]: unknown;
}

/** Response from `GET /api/projects/:id/pm/get/:itemId` — see src/routes/pm.ts. */
export type ItemResponse = { item?: Item } & Partial<Item>;

/** Response from `GET /api/projects/:id/pm/comments/:itemId` — see src/routes/pm.ts. */
export interface CommentsResponse {
  comments?: Comment[];
  error?: string;
}

/** Response from `GET /api/projects/:id/pm/notes/:itemId` — see src/routes/pm.ts. */
export interface NotesResponse {
  notes?: Note[];
  error?: string;
}

/** Response from `GET /api/projects/:id/pm/history/:itemId` — see src/routes/pm.ts. */
export interface HistoryResponse {
  history?: HistoryEntry[];
  error?: string;
}

/** Response from `GET /api/projects/:id/pm/learnings/:itemId` — see src/routes/pm.ts. */
export interface LearningsResponse {
  learnings?: Learning[];
  error?: string;
}

/** Response from `GET /api/projects/:id/pm/tests/:itemId` — see src/routes/pm.ts. */
export interface TestsResponse {
  tests?: TestEntry[];
  error?: string;
}

/** Response from `GET /api/projects/:id/pm/files/:itemId` — see src/routes/pm.ts. */
export interface FilesResponse {
  files?: FileEntry[];
  error?: string;
}

/**
 * Loose dependency row from `pm deps`. The pm CLI emits several key spellings
 * (`targetId`/`id`, `rel`/`relationship`/`kind`/`type`, …) so this mirrors the
 * `RawDependency` shape the items view already normalises.
 */
export interface DepRow {
  targetId?: string;
  id?: string;
  rel?: string;
  relationship?: string;
  kind?: string;
  type?: string;
  target?: string;
  targetTitle?: string;
  title?: string;
  [key: string]: unknown;
}

/** Response from `GET /api/projects/:id/pm/deps/:itemId` — see src/routes/pm.ts. */
export interface DepsResponse {
  deps?: DepRow[];
  dependencies?: DepRow[];
  error?: string;
}

/** A matched item from `pm update-many` (`item_plans`/`items`/`matched`). */
export interface MatchedItem {
  id?: string;
  title?: string;
}

/** Response from `POST /api/projects/:id/pm/update-many` — see src/routes/pm.ts. */
export interface UpdateManyResponse {
  item_plans?: MatchedItem[];
  items?: MatchedItem[];
  matched?: MatchedItem[];
  matched_count?: number;
  count?: number;
  total?: number;
  updated_count?: number;
  updated?: number;
  failed_count?: number;
  error?: string;
}

/** A per-item close result row from `pm close-many`. */
export interface CloseManyRow {
  id: string;
  status: 'ok' | 'failed';
  error?: string;
}

/** Response from `POST /api/projects/:id/pm/close-many` — see src/routes/pm.ts. */
export interface CloseManyResponse {
  closed_count?: number;
  failed_count?: number;
  skipped_count?: number;
  matched_count?: number;
  rows?: CloseManyRow[];
  error?: string;
}

/** Response from `GET /api/projects/:id/pm/stats` — see src/routes/pm.ts. */
export type StatsResponse = { stats?: Stats } & Partial<Stats> & { error?: string };

/** Response from `GET /api/projects/:id/pm/health` — see src/routes/pm.ts. */
export type HealthResponse = { health?: HealthData } & Partial<HealthData> & { error?: string };

/** Response from `GET /api/projects/:id/pm/activity` — see src/routes/pm.ts. */
export interface ActivityEntry extends HistoryEntry {
  type?: string;
  title?: string;
  id?: string;
}

/** Response from `GET /api/projects/:id/pm/activity` — see src/routes/pm.ts. */
export interface ActivityResponse {
  activity?: ActivityEntry[];
  items?: ActivityEntry[];
  error?: string;
}

/** Response from `POST /api/projects/:id/pm/search` — see src/routes/pm.ts. */
export interface SearchResponse {
  results?: Item[];
  items?: Item[];
  count?: number;
  error?: string;
}

/** A validation issue from `pm validate`. */
export interface ValidateIssue {
  message?: string;
  description?: string;
  id?: string;
  level?: string;
}

/** Response from `GET /api/projects/:id/pm/validate` — see src/routes/pm.ts. */
export interface ValidateResponse {
  issues?: ValidateIssue[];
  errors?: ValidateIssue[];
  violations?: ValidateIssue[];
  warnings?: ValidateIssue[];
  summary?: string;
  ok?: boolean;
  error?: string;
}

/** A calendar event from `pm calendar --view month`. */
export interface CalendarEvent {
  id?: string;
  itemId?: string;
  type?: string;
  title?: string;
  name?: string;
  date?: string;
  dueDate?: string;
  timestamp?: string;
}

/**
 * A calendar row as rendered in the calendar view. Combines the field spellings
 * from `pm calendar` events (`itemId`/`name`/`date`/`dueDate`/`timestamp`) with
 * the plain `Item` shape used by the `items` fallback so both code paths share
 * one optional-everything type.
 */
export interface CalendarListItem {
  id?: string;
  itemId?: string;
  type?: string;
  title?: string;
  name?: string;
  date?: string;
  dueDate?: string;
  timestamp?: string;
}

/** Response from `GET /api/projects/:id/pm/calendar` — see src/routes/pm.ts. */
export interface CalendarResponse {
  events?: CalendarEvent[];
  items?: Item[];
  error?: string;
}

/** Response from `GET /api/projects/:id/pm/context` — see src/routes/pm.ts. */
export interface ContextResponse {
  context?: ContextResponse;
  summary?: string;
  description?: string;
  activeItems?: Item[];
  inProgress?: Item[];
  open?: Item[];
  blockedItems?: Item[];
  blocked?: Item[];
  recentActivity?: ActivityEntry[];
  activity?: ActivityEntry[];
  error?: string;
}

/** A duplicate-group row from `pm dedupe-audit`. */
export interface DedupeGroup {
  score?: number;
  items?: Array<Item | string>;
}

/** Response from `GET /api/projects/:id/pm/dedupe-audit` — see src/routes/pm.ts. */
export interface DedupeResponse {
  groups?: DedupeGroup[];
  duplicates?: DedupeGroup[];
  error?: string;
}

/** A normalisation change from `pm normalize`. */
export interface NormalizeChange {
  message?: string;
  description?: string;
  id?: string;
}

/** The normalisation plan from `pm normalize`. */
export interface NormalizePlan {
  items?: NormalizeChange[];
  changes?: NormalizeChange[];
}

/** Response from `POST /api/projects/:id/pm/normalize` — see src/routes/pm.ts. */
export type NormalizeResponse = {
  plan?: NormalizePlan;
  normalization?: NormalizePlan;
} & Partial<NormalizePlan> & { error?: string };

/** A row in the `by_type` breakdown from `pm comments-audit`. */
export interface CommentsAuditTypeRow {
  type?: string;
  items_scanned?: number;
  items_with_comments?: number;
  comments_total?: number;
}

/** An item row from `pm comments-audit`. */
export interface CommentsAuditItem extends Item {
  comment_count?: number;
}

/** Summary block from `pm comments-audit`. */
export interface CommentsAuditSummary {
  totals?: {
    items_scanned?: number;
    items_with_comments?: number;
    comments_total?: number;
  };
  coverage?: {
    items_with_comments_percent?: number;
  };
  by_type?: CommentsAuditTypeRow[];
}

/** Response from `GET /api/projects/:id/pm/comments-audit` — see src/routes/pm.ts. */
export interface CommentsAuditResponse {
  items?: CommentsAuditItem[];
  summary?: CommentsAuditSummary;
  error?: string;
}

/** Default values a template may pre-fill. */
export interface TemplateDefaults {
  type?: string;
  priority?: number;
  tags?: string[];
  description?: string;
  sprint?: string;
  release?: string;
  assignee?: string;
  acceptance_criteria?: string;
  acceptanceCriteria?: string;
}

/** A template from `pm templates list`. */
export interface TemplateEntry {
  name?: string;
  id?: string;
  type?: string;
  priority?: number;
  tags?: string[];
  description?: string;
  sprint?: string;
  release?: string;
  assignee?: string;
  acceptance_criteria?: string;
  acceptanceCriteria?: string;
  defaults?: TemplateDefaults;
}

/** Response from `GET /api/projects/:id/pm/templates` — see src/routes/pm.ts. */
export interface TemplatesResponse {
  templates?: TemplateEntry[];
  error?: string;
}

/** Response from `GET /api/projects/:id/github` — see src/routes/github.ts. */
export interface GitHubRepoResponse {
  owner: string | null;
  repo: string | null;
  syncEnabled: boolean;
  linked: boolean;
}

/** A GitHub issue from `GET /api/projects/:id/github/issues` — see src/routes/github.ts. */
export interface GitHubIssueRow {
  number: number;
  title: string;
  body?: string | null;
  state?: 'open' | 'closed';
  labels?: Array<{ name: string }>;
  assignee?: { login: string } | null;
  html_url?: string;
  created_at?: string;
}

/** Response from `GET /api/projects/:id/github/issues` — see src/routes/github.ts. */
export interface GitHubIssuesResponse {
  issues: GitHubIssueRow[];
  error?: string;
}

/** A pushed item from `POST /api/projects/:id/github/push` — see src/routes/github.ts. */
export interface GitHubPushedItem {
  pmItemId: string;
  issueNumber: number;
  issueUrl: string;
}

/** Response from `POST /api/projects/:id/github/push` — see src/routes/github.ts. */
export interface GitHubPushResponse {
  pushed: GitHubPushedItem[];
  errors: string[];
  total: number;
}

/** Response from `PATCH /api/projects/:id/github/push/:itemId` — see src/routes/github.ts. */
export interface GitHubPushUpdateResponse {
  ok?: boolean;
  issueNumber?: number;
  issueUrl?: string;
  error?: string;
}

/** Response from `POST /api/projects/:id/github/import` — see src/routes/github.ts. */
export interface GitHubImportResponse {
  created: string[];
  errors: string[];
  total: number;
}

/** Response from `GET /api/projects/:id/pm/plan/:planId` — see src/routes/pm.ts. */
export interface PlanResponse {
  plan?: PlanResponsePayload;
  description?: string;
  error?: string;
}

/** Plan payload shared by the plan list and detail responses. */
export interface PlanResponsePayload {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  steps?: Array<PlanStepPayload>;
  approvedAt?: string;
  approved_at?: string;
  createdAt?: string;
  created_at?: string;
}

/** A step within a plan payload. */
export interface PlanStepPayload {
  id?: string;
  ref?: string;
  title?: string;
  description?: string;
  status?: string;
  blockedReason?: string;
  blocked_reason?: string;
  dependsOn?: string[];
  depends_on?: string[];
}

/**
 * Response from `POST /api/projects/:id/pm/items/:itemId/history-repair` — see
 * src/routes/pm.ts. NOTE: no such route is currently mounted on the server, so
 * the call rejects at runtime; the type models the `message` field the dry-run
 * toast reads so the (unreachable) success branch stays type-clean.
 */
export interface HistoryRepairResponse {
  message?: string;
}