import { invalidateEvidenceInspection, mountEvidenceInspection } from './evidence-inspection.js';
import { liveFieldValue, changedDraftFields, liveCollectionMarkup, refreshActionState, setHistoryPage, historyFailure } from '../live-copy.js';
// ═══════════════════════════════════════════════════════════════
// ITEMS VIEW
// ═══════════════════════════════════════════════════════════════
import { state } from '../state.js';
import { api } from '../api.js';
import { escHtml, statusBadge, priorityDot, typeIcon, relTime, fmtDate, setFormValue, resetButton } from '../utils.js';
import { showModal, hideModal, createModal, confirmDialog } from '../components/modals.js';
import { toast } from '../components/toast.js';
import { getTypes, getStatuses, TYPE_ICONS, PRIORITY_LABELS } from '../constants.js';
import { showView } from './router.js';
import { loadItemsBadge } from './projects.js';
import { renderLocalGraph, destroyLocalGraph } from './graph.js';
import { EMPTY_FILTERS, filtersToQueryString, filtersFromSearchParams, hasActiveFilters } from '../filters.js';
import type { Item } from '../types.js';

/** Keep readonly live values separate from formatted field labels. */
function liveAttrs(name: string, value: string): string {
  return `data-live-field="${name}" data-live-value="${escHtml(value)}"`;
}

/** Store the fetched item list outside the async loader. */
function rememberItems(items: Item[]): void {
  state.items = items;
}
import type {
  CloseManyResponse,
  CommentsResponse,
  DepsResponse,
  FilesResponse,
  HistoryResponse,
  DepRow,
  ItemResponse,
  LearningsResponse,
  ListResponse,
  ItemPlan,
  NotesResponse,
  TestsResponse,
  UpdateManyResponse,
} from '../api-types.js';

// Stash the bulk-update / bulk-close payloads on the apply buttons without
// mutating the DOM nodes. A module-scoped WeakMap per modal keeps the payload
// alive across the Preview → Apply call pair and is GC-friendly.
let itemsLayout: 'list' | 'board' = 'list';

const editBaselines = new WeakMap<HTMLElement, Record<string, string>>();
const EDIT_FIELDS: Record<string, string> = {
  title: 'title', status: 'status', priority: 'priority', tags: 'tags', description: 'desc',
  deadline: 'deadline', assignee: 'assignee', sprint: 'sprint', release: 'release', estimate: 'estimate',
  body: 'body', acceptanceCriteria: 'acceptance-criteria', blockedReason: 'blocked-reason',
};

/** Capture exactly the rendered draft values so untouched stale fields are never submitted. */
function readEditValues(): Record<string, string> {
  return Object.fromEntries(Object.entries(EDIT_FIELDS).map(([key, suffix]) => {
    const field = document.getElementById(`edit-${suffix}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    return [key, field?.value.trim() || ''];
  }));
}

const bulkUpdatePayloads = new WeakMap<HTMLElement, Record<string, string>>();
const bulkClosePayloads = new WeakMap<HTMLElement, BulkClosePayload>();

/** Payload stashed for `applyBulkClose` by `previewBulkClose`. */
interface BulkClosePayload {
  fStatus: string;
  fType: string;
  fSprint: string;
  fAssignee: string;
  targetStatus: string;
  reason: string;
}

// ─── Shared item-action helpers ───────────────────────────────

/** Toasts a standardized error message extracted from a caught error value. */
function toastError(err: unknown): void {
  toast(err instanceof Error ? err.message : String(err), 'error');
}

/** Performs a POST item action (start, pause, release) and refreshes the
 * view, optionally reopening the detail modal and refreshing the badge. */
async function postItemAction(endpoint: string, itemId: string, successMsg: string, withBadge: boolean): Promise<void> {
  try {
    await api('POST', `/projects/${state.currentProject!.id}/pm/${endpoint}/${itemId}`, {});
    toast(successMsg, 'success');
    openItemDetail(itemId);
    if (state.currentView === 'items') fetchAndRenderItems();
    if (withBadge) loadItemsBadge();
  } catch (err: unknown) { toastError(err); }
}

/** Refreshes the items view after a successful item action, optionally
 * reopening the detail modal or hiding it first, and refreshing the badge. */
function refreshAfterItemAction(opts: { toastMsg: string; reopenDetail?: string; hideDetail?: boolean; withBadge?: boolean }): void {
  toast(opts.toastMsg, 'success');
  if (opts.hideDetail) hideModal('item-detail-modal');
  if (opts.reopenDetail) openItemDetail(opts.reopenDetail);
  if (state.currentView === 'items') fetchAndRenderItems();
  if (opts.withBadge) loadItemsBadge();
}

/** Renders the "no items match" preview placeholder and disables the apply
 * button. */
function renderNoMatchPreview(previewEl: HTMLElement, applyBtn: HTMLButtonElement | null): void {
  previewEl.innerHTML = `<div style="color:var(--app-text-muted);font-size:13px;padding:10px 0">No items match the filter criteria.</div>`;
  if (applyBtn) applyBtn.disabled = true;
}

/** Toasts the result of a bulk operation, noting failures when present. */
function toastBulkResult(action: string, count: string | number, failed: number): void {
  if (failed > 0) {
    toast(`${action} ${count} item${count !== 1 ? 's' : ''} (${failed} failed)`, 'info');
  } else {
    toast(`${action} ${count} item${count !== 1 ? 's' : ''}`, 'success');
  }
}

/** Renders a preview list of matched items with their changes, capped at 8
 * entries with an overflow note. */
function renderMatchedPreview(matched: ItemPlan[], displayCount: number): string {
  return `${matched.slice(0, 8).map((it) => `<div style="color:var(--app-text-secondary);font-size:12px">· ${escHtml(it.id)}${it.changes?.length ? ` — ${escHtml(it.changes.map((c) => `${c.field}: ${String(c.before)} → ${String(c.after)}`).join(', '))}` : ''}</div>`).join('')}
            ${displayCount > 8 ? `<div style="color:var(--app-text-muted);font-size:12px;margin-top:4px">… and ${displayCount - 8} more</div>` : ''}`;
}

/**
 * Mirrors the current item filters into the page URL query string when the
 * items view is active, using history.replaceState so the filtered view is
 * shareable without adding back/forward entries. Does nothing on other views.
 */
function syncFiltersToUrl(): void {
  if (state.currentView !== 'items') return;
  const qs = filtersToQueryString(state.itemFilters);
  const url = '/items' + (qs ? `?${qs}` : '');
  try { history.replaceState(history.state, '', url); } catch { /* ignore */ }
}

/**
 * Reads item filters from the current URL query string into state. Only
 * replaces the in-memory filters when the URL actually carries filter
 * parameters, so navigating to /items without a query string preserves the
 * existing filters.
 */
export function loadFiltersFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  // Only override when the URL actually carries filter params, so navigating
  // to /items without a query string preserves the in-memory filters.
  const parsed = filtersFromSearchParams(params);
  if (hasActiveFilters(parsed)) {
    state.itemFilters = parsed;
  }
}

type RawDependency = DepRow;

const DEP_REL_OPTIONS = [
  { value: 'blocked_by', label: 'Blocked by / depends on' },
  { value: 'blocks', label: 'Blocks' },
  { value: 'parent', label: 'Parent' },
  { value: 'child', label: 'Child' },
  { value: 'related', label: 'Related' },
] as const;

/**
 * Normalizes a raw dependency relationship label to a canonical value by
 * trimming, lowercasing, and converting dashes to underscores, then applying a
 * known-alias map (e.g. blockedby → blocked_by). Returns the alias when one
 * exists, otherwise the normalized input unchanged.
 */
function normalizeDepRelation(raw?: string): string {
  const aliases: Record<string, string> = {
    blockedby: 'blocked_by',
    blocked_by: 'blocked_by',
    blockedbyid: 'blocked_by',
    depends_on: 'blocked_by',
    dependson: 'blocked_by',
    dependency: 'blocked_by',
    depends: 'blocked_by',
    blocked: 'blocked_by',
    parent_of: 'parent',
    child_of: 'child',
    relates_to: 'related',
    related_to: 'related',
    related: 'related',
    blocks: 'blocks',
  };
  const normalized = (raw || '').trim().toLowerCase().replace(/-/g, '_');
  return aliases[normalized] ?? normalized;
}

/**
 * Builds the HTML <option> elements for a dependency relationship dropdown from
 * the fixed DEP_REL_OPTIONS list, marking the option that matches the
 * normalized selected value as selected.
 */
function renderDependencyOptions(selected?: string): string {
  const current = normalizeDepRelation(selected);
  return DEP_REL_OPTIONS
    .map((option) => `<option value="${option.value}"${option.value === current ? ' selected' : ''}>${option.label}</option>`)
    .join('');
}

/**
 * Returns a human-readable display label for a dependency relationship by
 * looking up its normalized value in a fixed label map, falling back to the
 * original relationship string when no label is defined.
 */
function depLabel(rel: string): string {
  const labels: Record<string, string> = {
    blocked_by: 'Blocked by',
    blocks: 'Blocks',
    parent: 'Parent',
    child: 'Child',
    related: 'Related',
  };
  return labels[normalizeDepRelation(rel)] || rel;
}

function depTargetId(dep: RawDependency): string {
  return String(dep.targetId || dep.id || dep.target || '').trim();
}

function depRelation(dep: RawDependency): string {
  return normalizeDepRelation(String(dep.rel || dep.relationship || dep.type || dep.kind || 'blocked_by'));
}

// ═══════════════════════════════════════════════════════════════
// BULK UPDATE
// ═══════════════════════════════════════════════════════════════
/**
 * Opens the Bulk update items modal, which lets the user filter items and
 * choose fields to change across many items at once. Shows an info toast and
 * returns early when no project is currently selected.
 */
export function showBulkUpdateModal(): void {
  if (!state.currentProject) { toast('Select a project first', 'info'); return; }
  createModal('bulk-update-modal', 'Bulk update items', `
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:600;color:var(--app-text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Filter items</div>
      <div class="two-col">
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="bu-filter-status">
            <option value="">Any status</option>
            ${getStatuses(state.schema).map(s=>`<option value="${s}">${s.replace('_',' ')}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Type</label>
          <select class="form-select" id="bu-filter-type">
            <option value="">Any type</option>
            ${getTypes(state.schema).map(t=>`<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="two-col">
        <div class="form-group">
          <label class="form-label">Sprint</label>
          <input class="form-input" id="bu-filter-sprint" type="text" placeholder="Filter by sprint…">
        </div>
        <div class="form-group">
          <label class="form-label">Assignee</label>
          <input class="form-input" id="bu-filter-assignee" type="text" placeholder="Filter by assignee…">
        </div>
      </div>
    </div>
    <hr class="section-divider">
    <div style="font-size:11px;font-weight:600;color:var(--app-text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Fields to Update</div>
    <div class="two-col">
      <div class="form-group">
        <label class="form-label">Set priority</label>
        <select class="form-select" id="bu-set-priority">
          <option value="">— don't change —</option>
          ${[0,1,2,3,4].map(p=>`<option value="${p}">P${p}: ${PRIORITY_LABELS[p]}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Set status</label>
        <select class="form-select" id="bu-set-status">
          <option value="">— don't change —</option>
          ${getStatuses(state.schema).map(s=>`<option value="${s}">${s.replace('_',' ')}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="two-col">
      <div class="form-group">
        <label class="form-label">Set sprint</label>
        <input class="form-input" id="bu-set-sprint" type="text" placeholder="New sprint value…">
      </div>
      <div class="form-group">
        <label class="form-label">Set release</label>
        <input class="form-input" id="bu-set-release" type="text" placeholder="New release value…">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Set assignee</label>
      <input class="form-input" id="bu-set-assignee" type="text" placeholder="New assignee…">
    </div>
    <div id="bu-preview" style="margin-top:12px"></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-secondary" onclick="window.__app.previewBulkUpdate()">Preview</button>
      <button class="btn btn-primary" id="bu-apply-btn" onclick="window.__app.applyBulkUpdate()" disabled>Apply update</button>
    </div>`, '');
  showModal('bulk-update-modal');
}

/**
 * Runs a dry-run bulk update and renders a preview of the matched items and
 * their field changes inside the modal. Requires at least one field to update,
 * and stashes the actual (non-dry-run) payload on the Apply button so
 * applyBulkUpdate can run without re-reading the form.
 */
export async function previewBulkUpdate(): Promise<void> {
  const pid = state.currentProject?.id;
  if (!pid) return;
  const previewEl = document.getElementById('bu-preview');
  if (previewEl) previewEl.innerHTML = '<div class="loading-state" style="padding:12px 0"><div class="loading-spinner"></div></div>';

  const fStatus = (document.getElementById('bu-filter-status') as HTMLSelectElement | null)?.value || '';
  const fType = (document.getElementById('bu-filter-type') as HTMLSelectElement | null)?.value || '';
  const fSprint = (document.getElementById('bu-filter-sprint') as HTMLInputElement | null)?.value.trim() || '';
  const fAssignee = (document.getElementById('bu-filter-assignee') as HTMLInputElement | null)?.value.trim() || '';

  const uPriority = (document.getElementById('bu-set-priority') as HTMLSelectElement | null)?.value || '';
  const uStatus = (document.getElementById('bu-set-status') as HTMLSelectElement | null)?.value || '';
  const uSprint = (document.getElementById('bu-set-sprint') as HTMLInputElement | null)?.value.trim() || '';
  const uRelease = (document.getElementById('bu-set-release') as HTMLInputElement | null)?.value.trim() || '';
  const uAssignee = (document.getElementById('bu-set-assignee') as HTMLInputElement | null)?.value.trim() || '';

  const hasUpdate = uPriority || uStatus || uSprint || uRelease || uAssignee;
  if (!hasUpdate) {
    if (previewEl) previewEl.innerHTML = '<div style="color:var(--app-status-open);font-size:13px">Select at least one field to update.</div>';
    return;
  }

  // Build payload matching the backend's flat field format
  const payload: Record<string, string> = {};
  if (fStatus) payload.filterStatus = fStatus;
  if (fType) payload.filterType = fType;
  if (fSprint) payload.filterSprint = fSprint;
  if (fAssignee) payload.filterAssignee = fAssignee;
  if (uPriority) payload.priority = uPriority;
  if (uStatus) payload.status = uStatus;
  if (uSprint) payload.sprint = uSprint;
  if (uRelease) payload.release = uRelease;
  if (uAssignee) payload.assignee = uAssignee;
  payload.dryRun = 'true';

  try {
    const data = await api<UpdateManyResponse>('POST', `/projects/${pid}/pm/update-many`, payload);
    const matched: ItemPlan[] = data.item_plans ?? [];
    const count = data.matched_count ?? matched.length;
    const applyBtn = document.getElementById('bu-apply-btn') as HTMLButtonElement | null;
    if (previewEl) {
      const updateParts: string[] = [];
      if (uPriority) updateParts.push(`priority → P${uPriority}`);
      if (uStatus) updateParts.push(`status → ${uStatus}`);
      if (uSprint) updateParts.push(`sprint → ${uSprint}`);
      if (uRelease) updateParts.push(`release → ${uRelease}`);
      if (uAssignee) updateParts.push(`assignee → ${uAssignee}`);
      const updateDesc = updateParts.map(p=>`<strong>${escHtml(p)}</strong>`).join(', ');

      if (count === 0 && matched.length === 0) {
        renderNoMatchPreview(previewEl, applyBtn);
      } else {
        const displayCount = count || matched.length;
        previewEl.innerHTML = `
          <div style="background:var(--pm-stamp-wash);border:1px solid var(--pm-stamp-wash);border-radius:var(--app-radius);padding:10px 14px;font-size:13px">
            <div style="margin-bottom:8px">Will update <strong>${displayCount}</strong> item${displayCount!==1?'s':''}: ${updateDesc}</div>
            ${renderMatchedPreview(matched, displayCount)}
          </div>`;
        if (applyBtn) applyBtn.disabled = false;
        // Store payload for apply (without dryRun)
        const applyPayload = { ...payload };
        delete applyPayload.dryRun;
        if (applyBtn) bulkUpdatePayloads.set(applyBtn, applyPayload);
      }
    }
  } catch(err: unknown) {
    if (previewEl) previewEl.innerHTML = `<div style="color:var(--app-status-open);font-size:13px">Could not load this view. ${escHtml(err instanceof Error ? err.message : String(err))} Try again.</div>`;
  }
}

/**
 * Applies the bulk update payload stashed on the Apply button by
 * previewBulkUpdate, posting to the update-many endpoint. Reports the updated
 * and failed counts via toast, closes the bulk update modal, and refreshes the
 * items list and project badge.
 */
export async function applyBulkUpdate(): Promise<void> {
  const pid = state.currentProject?.id;
  if (!pid) return;
  const applyBtn = document.getElementById('bu-apply-btn') as HTMLButtonElement | null;
  const payload = applyBtn ? bulkUpdatePayloads.get(applyBtn) : undefined;
  if (!payload) { toast('Run preview first', 'info'); return; }
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Applying…'; }
  try {
    const data = await api<UpdateManyResponse>('POST', `/projects/${pid}/pm/update-many`, payload);
    const updated = data.updated_count ?? 'some';
    const failed = data.failed_count ?? 0;
    toastBulkResult('Updated', updated, failed);
    hideModal('bulk-update-modal');
    if (state.currentView === 'items') fetchAndRenderItems();
    loadItemsBadge();
  } catch(err: unknown) {
    toastError(err);
    if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Apply update'; }
  }
}

// ═══════════════════════════════════════════════════════════════
// BULK CLOSE
// ═══════════════════════════════════════════════════════════════
/**
 * Opens the Bulk close items modal, which lets the user filter items and close
 * or cancel many of them at once with a required reason. Shows an info toast
 * and returns early when no project is currently selected.
 */
export function showBulkCloseModal(): void {
  if (!state.currentProject) { toast('Select a project first', 'info'); return; }
  createModal('bulk-close-modal', 'Bulk close items', `
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:600;color:var(--app-text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Filter items to Close</div>
      <div class="two-col">
        <div class="form-group">
          <label class="form-label">Current status</label>
          <select class="form-select" id="bc-filter-status">
            <option value="">Any active status</option>
            ${getStatuses(state.schema).filter(s => s !== 'closed' && s !== 'canceled').map(s=>`<option value="${s}">${s.replace('_',' ')}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Type</label>
          <select class="form-select" id="bc-filter-type">
            <option value="">Any type</option>
            ${getTypes(state.schema).map(t=>`<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="two-col">
        <div class="form-group">
          <label class="form-label">Sprint</label>
          <input class="form-input" id="bc-filter-sprint" type="text" placeholder="Filter by sprint…">
        </div>
        <div class="form-group">
          <label class="form-label">Assignee</label>
          <input class="form-input" id="bc-filter-assignee" type="text" placeholder="Filter by assignee…">
        </div>
      </div>
    </div>
    <hr class="section-divider">
    <div style="font-size:11px;font-weight:600;color:var(--app-text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Close Action</div>
    <div class="two-col">
      <div class="form-group">
        <label class="form-label">Target status</label>
        <select class="form-select" id="bc-target-status">
          <option value="closed">closed</option>
          <option value="canceled">canceled</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Reason *</label>
        <input class="form-input" id="bc-reason" type="text" placeholder="Why are these items being closed?">
      </div>
    </div>
    <div id="bc-preview" style="margin-top:12px"></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn btn-secondary" onclick="window.__app.previewBulkClose()">Preview</button>
      <button class="btn btn-danger" id="bc-apply-btn" onclick="window.__app.applyBulkClose()" disabled>Close items</button>
    </div>`, '');
  showModal('bulk-close-modal');
}

/**
 * Previews the items that would be closed or canceled by running an
 * update-many dry-run, and renders the matched count and first few items
 * inside the modal. Requires a close reason, and stashes the close payload on
 * the Apply button for applyBulkClose to use.
 */
export async function previewBulkClose(): Promise<void> {
  const pid = state.currentProject?.id;
  if (!pid) return;
  const previewEl = document.getElementById('bc-preview');
  if (previewEl) previewEl.innerHTML = '<div class="loading-state" style="padding:12px 0"><div class="loading-spinner"></div></div>';

  const fStatus = (document.getElementById('bc-filter-status') as HTMLSelectElement | null)?.value || '';
  const fType = (document.getElementById('bc-filter-type') as HTMLSelectElement | null)?.value || '';
  const fSprint = (document.getElementById('bc-filter-sprint') as HTMLInputElement | null)?.value.trim() || '';
  const fAssignee = (document.getElementById('bc-filter-assignee') as HTMLInputElement | null)?.value.trim() || '';
  const targetStatus = (document.getElementById('bc-target-status') as HTMLSelectElement | null)?.value || 'closed';
  const reason = (document.getElementById('bc-reason') as HTMLInputElement | null)?.value.trim() || '';

  if (!reason) {
    if (previewEl) previewEl.innerHTML = '<div style="color:var(--app-status-blocked);font-size:13px">A close reason is required.</div>';
    return;
  }

  const payload: Record<string, string> = { reason: reason, targetStatus };
  if (fStatus) payload.filterStatus = fStatus;
  if (fType) payload.filterType = fType;
  if (fSprint) payload.filterSprint = fSprint;
  if (fAssignee) payload.filterAssignee = fAssignee;

  try {
    // Use update-many dry-run to preview which items will be closed/canceled.
    // Dry-run accepts status=closed for preview purposes; actual close uses close-many.
    const previewPayload: Record<string, string> = { status: targetStatus, dryRun: 'true' };
    if (fStatus) previewPayload.filterStatus = fStatus;
    if (fType) previewPayload.filterType = fType;
    if (fSprint) previewPayload.filterSprint = fSprint;
    if (fAssignee) previewPayload.filterAssignee = fAssignee;
    const data = await api<UpdateManyResponse>('POST', `/projects/${pid}/pm/update-many`, previewPayload);
    const matched: ItemPlan[] = data.item_plans ?? [];
    const count = data.matched_count ?? matched.length;
    const applyBtn = document.getElementById('bc-apply-btn') as HTMLButtonElement | null;
    if (previewEl) {
      if (count === 0 && matched.length === 0) {
        renderNoMatchPreview(previewEl, applyBtn);
      } else {
        const displayCount = count || matched.length;
        previewEl.innerHTML = `
          <div style="background:var(--pm-paper);border:1px solid var(--pm-paper);border-radius:var(--app-radius);padding:10px 14px;font-size:13px">
            <div style="margin-bottom:8px">Will <strong>${targetStatus}</strong> <strong>${displayCount}</strong> item${displayCount!==1?'s':''}. Reason: <em>${escHtml(reason)}</em></div>
            ${renderMatchedPreview(matched, displayCount)}
          </div>`;
        if (applyBtn) {
          applyBtn.disabled = false;
          bulkClosePayloads.set(applyBtn, { fStatus, fType, fSprint, fAssignee, targetStatus, reason });
        }
      }
    }
  } catch(err: unknown) {
    if (previewEl) previewEl.innerHTML = `<div style="color:var(--app-status-blocked);font-size:13px">Could not load this view. ${escHtml(err instanceof Error ? err.message : String(err))} Try again.</div>`;
  }
}

/**
 * Applies the bulk close payload stashed on the Apply button by
 * previewBulkClose, posting to the close-many endpoint which closes or cancels
 * each matched item with the chosen reason. Reports the closed and failed
 * counts via toast, closes the modal, and refreshes the items list and project
 * badge.
 */
export async function applyBulkClose(): Promise<void> {
  const pid = state.currentProject?.id;
  if (!pid) return;
  const applyBtn = document.getElementById('bc-apply-btn') as HTMLButtonElement | null;
  const bulkClosePayload = applyBtn ? bulkClosePayloads.get(applyBtn) : undefined;
  if (!bulkClosePayload) { toast('Run preview first', 'info'); return; }
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Closing…'; }

  // Use the close-many endpoint which calls pm close <id> <reason> for each matched item.
  // update-many --status closed is rejected by pm CLI; close-many handles it correctly.
  const payload: Record<string, string> = {
    reason: bulkClosePayload.reason,
    targetStatus: bulkClosePayload.targetStatus,
  };
  if (bulkClosePayload.fStatus) payload.filterStatus = bulkClosePayload.fStatus;
  if (bulkClosePayload.fType) payload.filterType = bulkClosePayload.fType;
  if (bulkClosePayload.fSprint) payload.filterSprint = bulkClosePayload.fSprint;
  if (bulkClosePayload.fAssignee) payload.filterAssignee = bulkClosePayload.fAssignee;

  try {
    const data = await api<CloseManyResponse>('POST', `/projects/${pid}/pm/close-many`, payload);
    const closed = data.closed_count ?? 'some';
    const failed = data.failed_count ?? 0;
    toastBulkResult('Closed', closed, failed);
    hideModal('bulk-close-modal');
    if (state.currentView === 'items') fetchAndRenderItems();
    loadItemsBadge();
  } catch(err: unknown) {
    toastError(err);
    if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Close items'; }
  }
}

/**
 * Renders the Items view into the page: a header with refresh and bulk
 * actions, the status filter tabs, the multi-field filter bar, and a loading
 * list placeholder, then fetches and renders the items. Shows an empty state
 * and returns when no project is selected.
 */
export async function renderItemsView(): Promise<void> {
  const el = document.getElementById('content-items');
  if (!el) return;
  if (!state.currentProject) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-text">No project selected</div></div>';
    return;
  }

  // Apply any filters carried in the URL query string (shared/bookmarked link).
  loadFiltersFromUrl();

  el.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Items</div>
        <div class="page-subtitle" id="items-subtitle">Loading…</div>
      </div>
      <div class="page-actions">
        <div class="items-layout-switch" role="group" aria-label="Item layout">
          <button class="btn btn-secondary btn-sm" data-items-layout="list" aria-pressed="${itemsLayout === 'list'}" onclick="window.__app.setItemsLayout('list')">List</button>
          <button class="btn btn-secondary btn-sm" data-items-layout="board" aria-pressed="${itemsLayout === 'board'}" onclick="window.__app.setItemsLayout('board')">Board</button>
        </div>
        <div class="items-secondary-actions">
        <button class="btn btn-secondary btn-sm" onclick="window.__app.renderItemsView()" title="Refresh">↺ Refresh</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__app.showBulkUpdateModal()">⊞ Bulk update</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__app.showBulkCloseModal()" title="Close or cancel many items at once">⊘ Bulk close</button>
        </div>
        <details class="items-more-actions">
          <summary class="btn btn-secondary btn-sm">More actions</summary>
          <div class="items-actions-menu">
        <button class="btn btn-secondary btn-sm" onclick="this.closest('details').open = false; window.__app.renderItemsView()" title="Refresh">↺ Refresh</button>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('details').open = false; window.__app.showBulkUpdateModal()">⊞ Bulk update</button>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('details').open = false; window.__app.showBulkCloseModal()" title="Close or cancel many items at once">⊘ Bulk close</button>
          </div>
        </details>
        <button class="btn btn-primary" onclick="window.__app.showView('create')">+ New item</button>
      </div>
    </div>
    <div class="status-tabs" style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
      ${['','open','in_progress','blocked','draft','closed','canceled'].map(s=>`<button class="btn btn-sm ${state.itemFilters.status===s?'btn-ghost active':'btn-ghost'}" onclick="window.__app.setStatusFilter('${s}')">${s===''?'All':s.replace('_',' ')}</button>`).join('')}
    </div>
    <div class="filter-bar">
      <select class="filter-select" id="filter-status" onchange="window.__app.applyItemFilters()">
        <option value="">All statuses</option>
        ${getStatuses(state.schema).map(s=>`<option value="${s}"${state.itemFilters.status===s?' selected':''}>${s.replace('_',' ')}</option>`).join('')}
      </select>
      <select class="filter-select" id="filter-type" onchange="window.__app.applyItemFilters()">
        <option value="">All types</option>
        ${getTypes(state.schema).map(t=>`<option value="${t}"${state.itemFilters.type===t?' selected':''}>${t}</option>`).join('')}
      </select>
      <select class="filter-select" id="filter-priority" onchange="window.__app.applyItemFilters()">
        <option value="">All priorities</option>
        ${[0,1,2,3,4].map(p=>`<option value="${p}"${state.itemFilters.priority===String(p)?' selected':''}>P${p}: ${PRIORITY_LABELS[p]}</option>`).join('')}
      </select>
      <input class="filter-select" id="filter-sprint" type="text" placeholder="Sprint…" value="${escHtml(state.itemFilters.sprint)}" oninput="window.__app.applyItemFilters()" style="width:100px">
      <input class="filter-select" id="filter-release" type="text" placeholder="Release…" value="${escHtml(state.itemFilters.release)}" oninput="window.__app.applyItemFilters()" style="width:100px">
      <input class="filter-select" id="filter-assignee" type="text" placeholder="Assignee…" value="${escHtml(state.itemFilters.assignee)}" oninput="window.__app.applyItemFilters()" style="width:110px">
      <input class="filter-select" id="filter-tag" type="text" placeholder="Tag…" value="${escHtml(state.itemFilters.tag)}" oninput="window.__app.applyItemFilters()" style="width:100px">
      <button class="btn btn-ghost btn-sm" onclick="window.__app.clearFilters()">Clear</button>
      <button class="btn btn-ghost btn-sm" onclick="window.__app.copyFilterLink()" title="Copy a shareable link to this filtered view">🔗 Copy link</button>
    </div>
    <div id="items-list"><div class="loading-state"><div class="loading-spinner"></div></div></div>`;

  await fetchAndRenderItems();
}

let itemsRequestSeq = 0;

/**
 * Fetches items for the current project using the active filters (capped at
 * 200, with tags filtered client-side because the list endpoint has no tag
 * flag), stores them in state, updates the count subtitle, and renders the
 * list. Live reconciliation preserves existing rows, captions and focus while
 * updating membership and board positions. Shows an error state if the request fails.
 */
export async function fetchAndRenderItems(preserveRows = false): Promise<void> {
  const pid = state.currentProject?.id;
  if (!pid) return;
  const requestSeq = ++itemsRequestSeq;
  const previousOrder = preserveRows ? new Map(state.items.map((item, index) => [item.id, index])) : null;
  const f = state.itemFilters;
  let params = 'limit=200';
  if (f.status) params += `&status=${encodeURIComponent(f.status)}`;
  if (f.type) params += `&type=${encodeURIComponent(f.type)}`;
  if (f.priority) params += `&priority=${encodeURIComponent(f.priority)}`;
  if (f.sprint) params += `&sprint=${encodeURIComponent(f.sprint)}`;
  if (f.release) params += `&release=${encodeURIComponent(f.release)}`;
  if (f.assignee) params += `&assignee=${encodeURIComponent(f.assignee)}`;

  const endpoint = f.status ? `list?${params}` : `list-all?${params}`;

  try {
    const data = await api<ListResponse>('GET',`/projects/${pid}/pm/${endpoint}`);
    if (state.currentProject?.id !== pid || requestSeq !== itemsRequestSeq) return;
    let items: Item[] = data.items || [];
    // Tag is filtered client-side (pm list has no --tag flag): match items
    // whose tag list contains the requested tag (case-insensitive).
    const tag = (f.tag || '').trim().toLowerCase();
    if (tag) {
      items = items.filter((i) => (i.tags || []).some((t) => t.toLowerCase() === tag));
    }
    if (previousOrder) items.sort((a, b) => (previousOrder.get(a.id) ?? previousOrder.size) - (previousOrder.get(b.id) ?? previousOrder.size));
    rememberItems(items);
    const sub = document.getElementById('items-subtitle');
    if (sub) sub.textContent = `${state.items.length} item${state.items.length!==1?'s':''}`;
    renderItemsList(preserveRows);
  } catch(err: unknown) {
    if (state.currentProject?.id !== pid || requestSeq !== itemsRequestSeq) return;
    const listEl = document.getElementById('items-list');
    if (listEl) listEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Failed to load items: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

/**
 * Renders the items list element from state.items, showing an empty-state
 * placeholder when there are no items or the mapped item rows otherwise.
 */
function renderItemsList(preserveRows = false, el = document.getElementById('items-list')): void {
  if (!el) return;
  if (preserveRows) {
    const previous = new Map([...el.querySelectorAll<HTMLElement>('.item-row')].map(row => [row.dataset.itemId, row]));
    const focused = document.activeElement;
    const staging = document.createElement('div');
    // Render the new membership offscreen, then reuse the patched rows and their captions.
    renderItemsList(false, staging);
    const unchanged = [...el.querySelectorAll('.item-row')].map(row => `${row.getAttribute('data-item-id')}:${row.closest('section')?.getAttribute('aria-label') || ''}`).join('|') === [...staging.querySelectorAll('.item-row')].map(row => `${row.getAttribute('data-item-id')}:${row.closest('section')?.getAttribute('aria-label') || ''}`).join('|');
    if (unchanged) return;
    staging.querySelectorAll<HTMLElement>('.item-row').forEach(row => {
      const existing = previous.get(row.dataset.itemId);
      if (existing) row.replaceWith(existing);
    });
    el.replaceChildren(...staging.childNodes);
    if (focused instanceof HTMLElement && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    return;
  }
  if (state.items.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon">📋</div>
      <div class="empty-state-text">No items found</div>
      <div class="empty-state-sub">Try adjusting filters or <a href="#" onclick="window.__app.showView('create');return false" style="color:var(--app-accent)">create a new item</a></div>
    </div>`;
    return;
  }
  if (itemsLayout === 'board') {
    const statuses = [...new Set(['open', 'in_progress', 'blocked', 'closed', 'canceled', ...state.items.map(item => item.status || 'draft')])];
    el.innerHTML = `<div class="items-board">${statuses.map(status => {
      const items = state.items.filter(item => (item.status || 'draft') === status);
      return `<section class="board-column" aria-label="${escHtml(status.replace('_', ' '))}"><h2 class="board-heading">${escHtml(status.replace('_', ' '))}<span>${items.length}</span></h2><div class="board-items">${items.map(item => renderItemRow(item)).join('') || '<p class="board-empty">No items in this state</p>'}</div></section>`;
    }).join('')}</div>`;
    return;
  }
  el.innerHTML = `<div class="item-list">${state.items.map(item => renderItemRow(item)).join('')}</div>`;
}

/**
 * Returns the HTML markup for a single items-list row: a clickable card
 * showing the item's type icon, id, title, tags, priority dot, and status
 * badge that opens the item detail modal when clicked.
 */
export function renderItemRow(item: Item, showStatus = true): string {
  const tags = (item.tags || []).map(tag => `<span class="tag">${escHtml(tag)}</span>`).join('');
  return `<div class="item-row" data-item-id="${escHtml(item.id)}" role="button" tabindex="0" onclick="window.__app.openItemDetail('${escHtml(item.id)}')">
    <div class="item-strip-line"><div class="item-strip live-field" ${liveAttrs('strip', liveFieldValue('strip', item))}>${escHtml(liveFieldValue('strip', item))}</div><div class="live-copy-caption" data-live-caption></div></div>
    <span class="item-title live-field" ${liveAttrs('title', item.title)}>${escHtml(item.title)}</span>
    <div class="item-meta"><div class="item-tags live-field" ${liveAttrs('tags', (item.tags || []).join(', '))}>${tags}</div>${showStatus ? statusBadge(item.status || 'draft') : ''}</div>
  </div>`;
}

/** Change the visible item layout while preserving filters and loaded records. */
export function setItemsLayout(layout: 'list' | 'board'): void {
  itemsLayout = layout;
  document.querySelectorAll<HTMLElement>('[data-items-layout]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.itemsLayout === layout)));
  renderItemsList();
}

/**
 * Reads the current values from every items filter-bar control into
 * state.itemFilters, mirrors them to the URL, and re-fetches and renders the
 * list.
 */
export function applyItemFilters(): void {
  const fs = document.getElementById('filter-status') as HTMLSelectElement | null;
  const ft = document.getElementById('filter-type') as HTMLSelectElement | null;
  const fp = document.getElementById('filter-priority') as HTMLSelectElement | null;
  const fsp = document.getElementById('filter-sprint') as HTMLInputElement | null;
  const frl = document.getElementById('filter-release') as HTMLInputElement | null;
  const fas = document.getElementById('filter-assignee') as HTMLInputElement | null;
  const ftg = document.getElementById('filter-tag') as HTMLInputElement | null;
  state.itemFilters.status = fs?.value || '';
  state.itemFilters.type = ft?.value || '';
  state.itemFilters.priority = fp?.value || '';
  state.itemFilters.sprint = fsp?.value || '';
  state.itemFilters.release = frl?.value || '';
  state.itemFilters.assignee = fas?.value || '';
  state.itemFilters.tag = ftg?.value || '';
  syncFiltersToUrl();
  fetchAndRenderItems();
}

/**
 * Resets the item filters to empty, clears every filter-bar control in the
 * DOM, mirrors the cleared filters to the URL, and re-renders the items list.
 */
export function clearFilters(): void {
  state.itemFilters = { ...EMPTY_FILTERS };
  const ids = ['filter-status','filter-type','filter-priority','filter-sprint','filter-release','filter-assignee','filter-tag'];
  ids.forEach(id => {
    const el = document.getElementById(id) as (HTMLInputElement | HTMLSelectElement) | null;
    if (el) el.value = '';
  });
  syncFiltersToUrl();
  fetchAndRenderItems();
}

/**
 * Builds a shareable URL for the current filtered items view and copies it to
 * the clipboard, toasting success or, if the clipboard write fails, toasting
 * the URL itself for manual copy.
 */
export async function copyFilterLink(): Promise<void> {
  const qs = filtersToQueryString(state.itemFilters);
  const url = `${window.location.origin}/items${qs ? `?${qs}` : ''}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Filtered view link copied', 'success');
  } catch {
    toast(url, 'info');
  }
}

/**
 * Sets the status filter to the provided value, mirrors it to the URL, and
 * re-renders the entire items view.
 */
export function setStatusFilter(status: string): void {
  state.itemFilters.status = status;
  syncFiltersToUrl();
  renderItemsView();
}

// ═══════════════════════════════════════════════════════════════
// ITEM DETAIL MODAL
// ═══════════════════════════════════════════════════════════════
/**
 * Opens the item detail modal and renders it. Fetches the item together with
 * its comments, history, dependencies, learnings, notes, tests, and linked
 * files in parallel (each detail call falls back to empty on failure) and
 * builds the full tabbed detail view.
 */
export async function openItemDetail(itemId: string): Promise<void> {
  invalidateEvidenceInspection();
  const pid = state.currentProject?.id;
  if (!pid) return;

  createModal('item-detail-modal', 'Loading…', '<div class="loading-state"><div class="loading-spinner"></div></div>', '', true);
  showModal('item-detail-modal');

  try {
    let historyError = '';
    const [itemData, commentsData, historyData, depsData, learningsData, notesData, testsData, filesData] = await Promise.all([
      api<ItemResponse>('GET',`/projects/${pid}/pm/get/${itemId}`),
      api<CommentsResponse>('GET',`/projects/${pid}/pm/comments/${itemId}`).catch(()=>({comments:[]})),
      api<HistoryResponse>('GET',`/projects/${pid}/pm/history/${itemId}`).catch((error: unknown): HistoryResponse => { historyError = historyFailure(error); return { history: [], order: 'oldest_first', has_more: false, next_cursor: null }; }),
      api<DepsResponse>('GET',`/projects/${pid}/pm/deps/${itemId}`).catch(()=>({deps:[]} as DepsResponse)),
      api<LearningsResponse>('GET',`/projects/${pid}/pm/learnings/${itemId}`).catch(()=>({learnings:[]})),
      api<NotesResponse>('GET',`/projects/${pid}/pm/notes/${itemId}`).catch(()=>({notes:[]})),
      api<TestsResponse>('GET',`/projects/${pid}/pm/tests/${itemId}`).catch(()=>({tests:[]})),
      api<FilesResponse>('GET',`/projects/${pid}/pm/files/${itemId}`).catch(()=>({files:[]})),
    ]);

    const item: Item = itemData.item || (itemData as Item);
    const comments = commentsData.comments || [];
    const history = [...historyData.history].reverse();
    const deps = depsData.deps || depsData.dependencies || [];
    const learnings = learningsData.learnings || [];
    const notes = notesData.notes || [];
    const tests = testsData.tests || [];
    const files = filesData.files || [];

    const modal = document.getElementById('item-detail-modal');
    if (modal) {
      const titleEl = modal.querySelector('.modal-title');
      if (titleEl) {
        titleEl.setAttribute('data-item-id', item.id);
        titleEl.innerHTML = `<div class="item-detail-id live-field" ${liveAttrs('strip', liveFieldValue('strip', item))}>${escHtml(liveFieldValue('strip', item))}</div><h2 class="item-sheet-heading item-detail-title live-field" ${liveAttrs('title', item.title)}>${escHtml(item.title || 'Untitled item')}</h2><div class="live-copy-caption" data-live-caption></div>`;
      }
    }


    const notesHtml = notes.length === 0
      ? '<div style="color:var(--app-text-muted);font-size:13px;margin-bottom:12px">No notes yet</div>'
      : notes.map((n)=>`
          <div class="notes-item">
            <div class="notes-item-meta">${relTime(n.timestamp||n.created_at||'')}</div>
            <div class="notes-item-text">${escHtml(n.text||n.content||JSON.stringify(n))}</div>
          </div>`).join('');

    const testsHtml = tests.length === 0
      ? '<div style="color:var(--app-text-muted);font-size:13px;margin-bottom:12px">No tests defined</div>'
      : tests.map((t)=>`
          <div class="test-item">
            <div style="flex:1">
              <div class="test-item-cmd">${escHtml(t.command||t.cmd||JSON.stringify(t))}</div>
              ${t.description ? `<div style="font-size:12px;color:var(--app-text-secondary);margin-top:3px">${escHtml(t.description)}</div>` : ''}
            </div>
          </div>`).join('');

    const commentsHtml = liveCollectionMarkup('comments', comments);
    const historyHtml = liveCollectionMarkup('history', history);

    const bodyEl = modal?.querySelector<HTMLElement>('.modal-body');
    if (bodyEl) {
      bodyEl.dataset.itemId = item.id;
      bodyEl.innerHTML = `
      <div class="item-detail-header">
        <div class="item-detail-meta">
          <span class="detail-status-slot live-field" ${liveAttrs('detailStatus', item.status || 'draft')}>${item.status === 'closed' ? '<span class="closed-stamp">Closed</span>' : statusBadge(item.status || 'draft')}</span>
          <div class="meta-chip">Priority <strong class="mono live-field" ${liveAttrs('priority', String(item.priority ?? 4))}>P${item.priority ?? 4}</strong></div>
          ${item.created_at ? `<div class="meta-chip">Created <strong>${fmtDate(item.created_at)}</strong></div>` : ''}
          ${item.updated_at ? `<div class="meta-chip">Updated <strong>${relTime(item.updated_at)}</strong></div>` : ''}
          ${item.parent ? `<div class="meta-chip">Parent <strong class="mono">${escHtml(item.parent)}</strong></div>` : ''}
          ${item.claimedBy ? `<div class="meta-chip">Claimed by <strong>${escHtml(item.claimedBy)}</strong></div>` : ''}
          ${item.estimated_minutes ? `<div class="meta-chip">~${item.estimated_minutes}m</div>` : ''}
          ${item.blockedBy||item['blocked-by'] ? `<div class="meta-chip" style="border-color:var(--pm-paper);color:var(--pm-danger)">Blocked by <strong class="mono">${escHtml(item.blockedBy||item['blocked-by']||'')}</strong></div>` : ''}
        </div>
        <div class="live-meta">
          ${[['assignee', 'Assignee'], ['sprint', 'Sprint'], ['release', 'Release'], ['deadline', 'Due'], ['tags', 'Tags']].map(([name, label]) => `<div><div class="live-meta-label">${label}</div><div class="live-field" ${liveAttrs(name, liveFieldValue(name, item))}>${escHtml(name === 'deadline' ? fmtDate(item.deadline) : liveFieldValue(name, item)) || '—'}</div></div>`).join('')}
        </div>
        <div class="live-status-note live-field" ${liveAttrs('blockedReason', liveFieldValue('blockedReason', item))}>${liveFieldValue('blockedReason', item) ? `Blocked: ${escHtml(liveFieldValue('blockedReason', item))}` : ''}</div>
        <div class="claim-btn-wrap">
          <button class="btn btn-secondary btn-sm" data-item-action="claim" onclick="window.__app.claimItem('${escHtml(itemId)}')">⊕ Claim</button>
          <button class="btn btn-ghost btn-sm" data-item-action="release" onclick="window.__app.releaseItem('${escHtml(itemId)}')">⊖ Release</button>
          <button class="btn btn-secondary btn-sm" data-item-action="start" aria-disabled="${item.status !== 'open'}" onclick="window.__app.startItem('${escHtml(itemId)}')">Start</button>
          <button class="btn btn-secondary btn-sm" data-item-action="pause" aria-disabled="${item.status !== 'in_progress'}" onclick="window.__app.pauseItem('${escHtml(itemId)}')">Pause</button>
          <button class="btn btn-secondary btn-sm" data-item-action="reopen" onclick="window.__app.reopenItem('${escHtml(itemId)}')">Reopen</button>
          <button class="btn btn-danger btn-sm" onclick="window.__app.confirmDeleteItem('${escHtml(itemId)}')">Delete item</button>
          <button class="btn btn-ghost btn-sm" data-template-item="${escHtml(JSON.stringify(item))}" onclick="window.__app.useItemAsTemplate(JSON.parse(this.dataset.templateItem))" title="Open create form pre-filled with this item's fields">⊡ Use as Template</button>
        </div>
      </div>

      <div class="item-detail-section">
        <div class="item-detail-section-title">Description</div>
        <div class="item-detail-desc live-field" ${liveAttrs('description', item.description || '')}>${escHtml(item.description) || 'No description yet'}</div>
      </div>

      <div class="item-detail-section">
        <div class="item-detail-section-title">Acceptance criteria</div>
        <div class="item-detail-desc live-field" ${liveAttrs('acceptanceCriteria', liveFieldValue('acceptanceCriteria', item))}>${escHtml(liveFieldValue('acceptanceCriteria', item)) || 'No acceptance criteria yet'}</div>
      </div>

      <details class="item-detail-section evidence-panel" data-evidence-panel>
        <summary class="item-detail-section-title">Evidence freshness</summary>
        <button type="button" class="btn btn-secondary" data-evidence-refresh>Refresh evidence</button>
        <p role="status" aria-live="polite" data-evidence-status>Open to inspect current sources.</p>
        <div data-evidence-body></div>
      </details>
      <div class="tabs">
        <div class="tab active" onclick="window.__app.switchDetailTab(this,'tab-comments')">Comments (${comments.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-update')">Update</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-notes')">Notes (${notes.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-deps')">Deps (${deps.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-graph','${escHtml(itemId)}')">◎ Graph</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-learnings')">Learnings (${learnings.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-tests')">Tests (${tests.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-files')">Files (${files.length})</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-history')">History</div>
        <div class="tab" onclick="window.__app.switchDetailTab(this,'tab-close')">Close</div>
      </div>

      <div id="tab-comments">
        <div class="live-collection live-field" ${liveAttrs('comments', JSON.stringify(comments))}>${commentsHtml}</div>
        <hr class="section-divider">
        <div class="form-group">
          <label class="form-label">Add comment</label>
          <textarea class="form-textarea" id="new-comment" placeholder="Write a comment…" rows="3"></textarea>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__app.addComment('${escHtml(itemId)}')">Post comment</button>
      </div>

      <div id="tab-update" style="display:none">
        <div class="form-group">
          <label class="form-label">Title</label>
          <input class="form-input" id="edit-title" type="text" value="${escHtml(item.title)}">
        </div>
        <div class="two-col">
          <div class="form-group">
            <label class="form-label">Status</label>
            <select class="form-select" id="edit-status">
              ${getStatuses(state.schema).map(s=>`<option value="${s}"${item.status===s?' selected':''}>${s.replace('_',' ')}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Priority</label>
            <select class="form-select" id="edit-priority">
              ${[0,1,2,3,4].map(p=>`<option value="${p}"${item.priority===p?' selected':''}>P${p}: ${PRIORITY_LABELS[p]}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Tags (comma-separated)</label>
          <input class="form-input" id="edit-tags" type="text" value="${escHtml((item.tags||[]).join(', '))}">
        </div>
        <div class="two-col">
          <div class="form-group">
            <label class="form-label">Deadline</label>
            <input class="form-input" id="edit-deadline" type="text" placeholder="+1d, +1w, 2026-06-01" value="${escHtml(item.deadline||'')}">
          </div>
          <div class="form-group">
            <label class="form-label">Assignee</label>
            <input class="form-input" id="edit-assignee" type="text" value="${escHtml(item.assignee||'')}">
          </div>
        </div>
        <div class="two-col">
          <div class="form-group">
            <label class="form-label">Sprint</label>
            <input class="form-input" id="edit-sprint" type="text" value="${escHtml(item.sprint||'')}">
          </div>
          <div class="form-group">
            <label class="form-label">Release</label>
            <input class="form-input" id="edit-release" type="text" value="${escHtml(item.release||'')}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Estimated minutes</label>
          <input class="form-input" id="edit-estimate" type="number" min="1" value="${escHtml(String(item.estimated_minutes||''))}">
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <textarea class="form-textarea" id="edit-desc" rows="4">${escHtml(item.description||'')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Body (extended)</label>
          <textarea class="form-textarea" id="edit-body" rows="3">${escHtml(item.body||'')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Acceptance criteria</label>
          <textarea class="form-textarea" id="edit-acceptance-criteria" rows="2">${escHtml(item.acceptance_criteria||item.acceptanceCriteria||'')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Blocked reason</label>
          <textarea class="form-textarea" id="edit-blocked-reason" rows="2" placeholder="Why is this item blocked?">${escHtml(item.blockedReason||item['blocked-reason']||'')}</textarea>
        </div>
        <button class="btn btn-primary" onclick="window.__app.updateItem('${escHtml(itemId)}')">Save changes</button>
      </div>

      <div id="tab-notes" style="display:none">
        <div style="margin-bottom:16px">${notesHtml}</div>
        <hr class="section-divider">
        <div class="form-group">
          <label class="form-label">Add note</label>
          <textarea class="form-textarea" id="new-note" placeholder="Add a note to this item…" rows="4"></textarea>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__app.addNote('${escHtml(itemId)}')">Add note</button>
        <hr class="section-divider">
        <div class="form-group">
          <label class="form-label">Append to Description</label>
          <textarea class="form-textarea" id="new-append" placeholder="Text to append…" rows="3"></textarea>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="window.__app.appendItem('${escHtml(itemId)}')">Append</button>
      </div>

      <div id="tab-deps" style="display:none">
        <div style="margin-bottom:16px">
          ${deps.length === 0
            ? `<div style="color:var(--app-text-muted);font-size:13px;margin-bottom:12px">No dependencies</div>`
            : deps.map((dep: RawDependency)=> {
              const target = depTargetId(dep);
              const rel = depRelation(dep);
              const title = dep.targetTitle || dep.title || '';
            return `<div class="dep-row">
                <span class="dep-rel">${escHtml(depLabel(rel))}</span>
                <span class="dep-id" onclick="window.__app.hideModal('item-detail-modal');window.__app.openItemDetail('${escHtml(target)}')">
                  ${escHtml(target)}
                </span>
                <span style="flex:1;color:var(--app-text-secondary);font-size:12px">${escHtml(String(title))}</span>
                <button class="btn btn-danger btn-sm" onclick="window.__app.removeDep('${escHtml(itemId)}','${escHtml(target)}','${escHtml(rel)}')">Remove</button>
              </div>`;
            }).join('')
          }
        </div>
        <hr class="section-divider">
        <div style="font-size:11px;font-weight:600;color:var(--app-text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Add dependency</div>
        <div class="row" style="margin-bottom:8px">
          <input class="form-input flex-1" id="dep-target-id" type="text" placeholder="Item ID (e.g. ${escHtml(state.currentProject?.prefix||'proj')}-5)">
          <select class="form-select" id="dep-rel" style="width:200px">
            ${renderDependencyOptions()}
          </select>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__app.addDep('${escHtml(itemId)}')">Add dependency</button>
      </div>

      <div id="tab-learnings" style="display:none">
        <div style="margin-bottom:16px">
          ${learnings.length === 0
            ? `<div style="color:var(--app-text-muted);font-size:13px;margin-bottom:12px">No learnings recorded</div>`
            : learnings.map((l)=>`<div class="learning-row">
                <div style="font-size:11px;color:var(--app-text-muted);margin-bottom:3px">${relTime(l.timestamp||l.created_at||'')}</div>
                ${escHtml(l.text||l.content||JSON.stringify(l))}
              </div>`).join('')
          }
        </div>
        <hr class="section-divider">
        <div class="form-group">
          <label class="form-label">Add learning</label>
          <textarea class="form-textarea" id="new-learning" placeholder="What did you learn working on this item?" rows="3"></textarea>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__app.addLearning('${escHtml(itemId)}')">Record learning</button>
      </div>

      <div id="tab-tests" style="display:none">
        <div style="margin-bottom:16px">${testsHtml}</div>
        <hr class="section-divider">
        <div style="font-size:11px;font-weight:600;color:var(--app-text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Add test</div>
        <div class="form-group">
          <label class="form-label">Command *</label>
          <input class="form-input" id="new-test-cmd" type="text" placeholder="npm test, pytest tests/, etc.">
        </div>
        <div class="form-group">
          <label class="form-label">Description (optional)</label>
          <input class="form-input" id="new-test-desc" type="text" placeholder="What does this test verify?">
        </div>
        <button class="btn btn-primary btn-sm" onclick="window.__app.addTest('${escHtml(itemId)}')">Add test</button>
      </div>

      <div id="tab-history" style="display:none"><div class="live-collection live-field" ${liveAttrs('history', JSON.stringify(history))}>${historyHtml}</div><p data-history-status role="status"></p><button type="button" class="btn btn-secondary btn-sm" data-history-older hidden>Load older history</button></div>

      <!-- Local graph tab -->
      <div id="tab-graph" style="display:none">
        <div class="local-graph-controls" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:12px;color:var(--app-text-muted)">Depth</span>
          <input type="range" id="local-graph-depth" min="1" max="5" step="1" value="2" class="graph-depth-slider" style="width:100px">
          <span id="local-graph-depth-val" style="font-size:11px;color:var(--app-accent);font-family:var(--pm-font-mono);min-width:12px">2</span>
          <button class="btn btn-ghost btn-sm" onclick="window.__app.openGraphAt('${escHtml(itemId)}')" title="Open in full graph view" style="margin-left:auto">Full graph →</button>
        </div>
        <div id="local-graph-canvas" style="height:320px;border-radius:var(--pm-radius-sm);overflow:hidden;background:var(--pm-paper);border:1px solid var(--pm-rule)"></div>
      </div>

      <div id="tab-files" style="display:none">
        <div style="margin-bottom:16px">
          ${files.length === 0
            ? '<div style="color:var(--app-text-muted);font-size:13px;margin-bottom:12px">No files linked</div>'
            : files.map((f) => `
                <div class="file-row">
                  <span style="color:var(--app-text-muted)">□</span>
                  <span class="file-path">${escHtml(f.path || f.name || JSON.stringify(f))}</span>
                  ${f.scope ? `<span style="font-size:10px;color:var(--app-text-muted);background:var(--app-bg-input);padding:2px 6px;border-radius:var(--pm-radius-sm)">${escHtml(f.scope)}</span>` : ''}
                </div>`).join('')
          }
        </div>
        <hr class="section-divider">
        <div style="font-size:11px;font-weight:600;color:var(--app-text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Link files</div>
        <div class="row" style="margin-bottom:8px">
          <input class="form-input flex-1" id="file-path-input" type="text" placeholder="src/components/App.tsx">
          <button class="btn btn-primary btn-sm" onclick="window.__app.addFileLink('${escHtml(itemId)}')">Link file</button>
        </div>
      </div>

      <div id="tab-close" style="display:none">
        <div class="form-group">
          <label class="form-label">Close reason *</label>
          <textarea class="form-textarea" id="close-reason" placeholder="Why is this being closed?" rows="3"></textarea>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" data-item-action="close" aria-disabled="${['closed', 'canceled'].includes(item.status || '')}" onclick="window.__app.closeItem('${escHtml(itemId)}','closed')">Close item</button>
          <button class="btn btn-secondary" data-item-action="close" aria-disabled="${['closed', 'canceled'].includes(item.status || '')}" onclick="window.__app.closeItem('${escHtml(itemId)}','canceled')">Cancel item</button>
          <button class="btn btn-danger btn-sm" onclick="window.__app.confirmDeleteItem('${escHtml(itemId)}')">Delete item</button>
        </div>
      </div>
    `;
      mountEvidenceInspection(bodyEl as HTMLElement, pid, item.id);
      refreshActionState(bodyEl, item);
      setHistoryPage(bodyEl, historyData, pid, item.id);
      if (historyError) {
        const historyStatus = bodyEl.querySelector<HTMLElement>('[data-history-status]');
        if (historyStatus) historyStatus.textContent = historyError;
        bodyEl.querySelector('[data-live-field="history"]')?.replaceChildren();
      }
      if (modal) editBaselines.set(modal, readEditValues());
    }
  } catch(err: unknown) {
    const bodyEl = document.getElementById('item-detail-modal')?.querySelector('.modal-body');
    if (bodyEl) bodyEl.innerHTML = `<div class="empty-state"><div class="empty-state-text">Failed to load: ${escHtml(err instanceof Error ? err.message : String(err))}</div></div>`;
  }
}

/**
 * Switches the item detail modal to the selected tab: toggles the active class
 * on the tabs, shows the target tab panel while hiding the others, tears down
 * the local graph when leaving the graph tab, and initializes the graph along
 * with its depth-slider listener when entering the graph tab with a nodeId.
 */
export function switchDetailTab(tabEl: HTMLElement, targetId: string, nodeId?: string): void {
  const allTabs = tabEl.parentElement?.querySelectorAll('.tab');
  allTabs?.forEach(t => t.classList.remove('active'));
  tabEl.classList.add('active');
  const ids = ['tab-comments','tab-update','tab-notes','tab-deps','tab-graph','tab-learnings','tab-tests','tab-files','tab-history','tab-close'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === targetId ? '' : 'none';
    // Clean up local graph canvas when switching away
    if (id === 'tab-graph' && id !== targetId) destroyLocalGraph('local-graph-canvas');
  });
  // Initialize local graph when tab is opened
  if (targetId === 'tab-graph' && nodeId) {
    const depthSlider = document.getElementById('local-graph-depth') as HTMLInputElement | null;
    const depthVal    = document.getElementById('local-graph-depth-val');
    const depth = depthSlider ? parseInt(depthSlider.value, 10) : 2;
    void renderLocalGraph('local-graph-canvas', nodeId, depth);
    depthSlider?.addEventListener('input', () => {
      const d = parseInt(depthSlider.value, 10);
      if (depthVal) depthVal.textContent = String(d);
      void renderLocalGraph('local-graph-canvas', nodeId, d);
    });
  }
}

/**
 * Posts the comment typed into the detail modal's comment box to the item,
 * requiring non-empty text. On success it clears the box, toasts confirmation,
 * and reopens the item detail to refresh the comments tab.
 */
export async function addComment(itemId: string): Promise<void> {
  const el = document.getElementById('new-comment') as HTMLTextAreaElement | null;
  if (!el) return;
  const text = el.value.trim();
  if (!text) { toast('Comment cannot be empty','error'); return; }
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/comments/${itemId}`,{text});
    toast('Comment added','success');
    el.value = '';
    openItemDetail(itemId);
  } catch(err: unknown) { toastError(err); }
}

/**
 * Posts the note typed into the detail modal's note box to the item, requiring
 * non-empty text. On success it clears the box and toasts confirmation.
 */
export async function addNote(itemId: string): Promise<void> {
  const el = document.getElementById('new-note') as HTMLTextAreaElement | null;
  if (!el) return;
  const text = el.value.trim();
  if (!text) { toast('Note cannot be empty','error'); return; }
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/notes/${itemId}`,{text});
    toast('Note added','success');
    el.value = '';
  } catch(err: unknown) { toastError(err); }
}

/**
 * Appends the text from the detail modal's append box to the item's
 * description, requiring non-empty text. On success it clears the box and
 * toasts confirmation.
 */
export async function appendItem(itemId: string): Promise<void> {
  const el = document.getElementById('new-append') as HTMLTextAreaElement | null;
  if (!el) return;
  const text = el.value.trim();
  if (!text) { toast('Text cannot be empty','error'); return; }
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/append/${itemId}`,{text});
    toast('Appended','success');
    el.value = '';
  } catch(err: unknown) { toastError(err); }
}

/**
 * Saves the item detail's Update form: reads every edit field, requires a
 * title, and PATCHes the changed fields to the backend. On success it reopens
 * the item detail and refreshes the items list and project badge.
 */
export async function updateItem(itemId: string): Promise<void> {
  const draft = readEditValues();
  if (!draft.title) { toast('Enter a title before saving.','error'); return; }
  const modal = document.getElementById('item-detail-modal');
  const payload = changedDraftFields(modal ? editBaselines.get(modal) || {} : {}, draft);
  if (!Object.keys(payload).length) { toast('No changes to save.','info'); return; }
  try {
    await api('PATCH', `/projects/${state.currentProject!.id}/pm/update/${itemId}`, payload);
    refreshAfterItemAction({ toastMsg: 'Item updated', reopenDetail: itemId, withBadge: true });
  } catch (err: unknown) { toastError(err); }
}

/**
 * Closes or cancels the item with a required reason. For canceled it first
 * sets the status to canceled via the update endpoint before posting the close
 * reason; for closed it posts the close reason directly. Reports the outcome,
 * hides the detail modal, and refreshes the items list and project badge.
 */
export async function closeItem(itemId: string, targetStatus: string): Promise<void> {
  const reasonEl = document.getElementById('close-reason') as HTMLTextAreaElement | null;
  const reason = reasonEl?.value?.trim();
  if (!reason) { toast('Close reason is required','error'); return; }
  try {
    if (targetStatus === 'canceled') {
      await api('PATCH',`/projects/${state.currentProject!.id}/pm/update/${itemId}`,{status:'canceled'});
      await api('POST',`/projects/${state.currentProject!.id}/pm/close/${itemId}`,{reason});
    } else {
      await api('POST',`/projects/${state.currentProject!.id}/pm/close/${itemId}`,{reason});
    }
    refreshAfterItemAction({ toastMsg: `Item ${targetStatus}`, hideDetail: true, withBadge: true });
  } catch(err: unknown) { toastError(err); }
}

/**
 * Shows a confirmation dialog and, on confirm, DELETEs the item, hides the
 * detail modal, and refreshes the items list and project badge.
 */
export function confirmDeleteItem(itemId: string): void {
  confirmDialog('Delete item?', 'This action cannot be undone. The item and all its data will be permanently removed.', async () => {
    try {
      await api('DELETE',`/projects/${state.currentProject!.id}/pm/delete/${itemId}`);
      refreshAfterItemAction({ toastMsg: 'Item deleted', hideDetail: true, withBadge: true });
    } catch(err: unknown) { toastError(err); }
  }, true);
}

// ═══════════════════════════════════════════════════════════════
// CLAIM / RELEASE / START / PAUSE
// ═══════════════════════════════════════════════════════════════
/**
 * Claims the item for the current user via the claim endpoint, dimming the
 * matching list row optimistically. On success it reopens the detail and
 * refreshes the list; on failure it restores the row opacity and toasts the
 * error.
 */
export async function claimItem(itemId: string): Promise<void> {
  const row = document.querySelector(`.item-row[onclick*="${itemId}"]`) as HTMLElement | null;
  if (row) row.style.opacity = '0.6';
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/claim/${itemId}`,{});
    toast('Item claimed','success');
    openItemDetail(itemId);
    if (state.currentView==='items') fetchAndRenderItems();
  } catch(err: unknown) { toastError(err); if (row) row.style.opacity = ''; }
}

/**
 * Releases the current user's claim on the item via the release endpoint, then
 * reopens the detail and refreshes the items list.
 */
export async function releaseItem(itemId: string): Promise<void> {
  await postItemAction('release', itemId, 'Item released', false);
}

/**
 * Starts the item (moving it into in_progress) via the start-task endpoint,
 * then reopens the detail and refreshes the items list and project badge.
 */
export async function startItem(itemId: string): Promise<void> {
  await postItemAction('start-task', itemId, 'Item started', true);
}

/**
 * Pauses the in-progress item via the pause-task endpoint, then reopens the
 * detail and refreshes the items list and project badge.
 */
export async function pauseItem(itemId: string): Promise<void> {
  await postItemAction('pause-task', itemId, 'Item paused', true);
}

/** Reopen a finished item and refresh its sheet and list membership. */
export async function reopenItem(itemId: string): Promise<void> {
  try {
    await api('PATCH', `/projects/${state.currentProject!.id}/pm/update/${itemId}`, { status: 'open' });
    refreshAfterItemAction({ toastMsg: 'Item reopened', reopenDetail: itemId, withBadge: true });
  } catch (err: unknown) { toastError(err); }
}

// ═══════════════════════════════════════════════════════════════
// DEPS / LEARNINGS / TESTS / FILES
// ═══════════════════════════════════════════════════════════════
/**
 * Adds a dependency to the item from the detail modal's dependency inputs:
 * reads and normalizes the target id and relationship, rejects an empty or
 * self-referential target, and posts to the deps endpoint. On success it
 * reopens the item detail.
 */
export async function addDep(itemId: string): Promise<void> {
  const targetIdEl = document.getElementById('dep-target-id') as HTMLInputElement | null;
  const relEl = document.getElementById('dep-rel') as HTMLSelectElement | null;
  const targetId = targetIdEl?.value?.trim() || '';
  const rel = normalizeDepRelation(relEl?.value || 'blocked_by');
  if (!targetId) { toast('Target item ID is required','error'); return; }
  if (targetId === itemId) {
    toast('A dependency cannot target the same item','error');
    return;
  }
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/deps/${itemId}`,{targetId,rel});
    toast('Dependency added','success');
    openItemDetail(itemId);
  } catch(err: unknown) { toastError(err); }
}

/**
 * Removes a dependency from the item after confirming with the user. Normalizes
 * the relationship, requires a target id, and DELETEs the dependency from the
 * deps endpoint; on success it reopens the item detail.
 */
export async function removeDep(itemId: string, targetId: string, relation: string): Promise<void> {
  const rel = normalizeDepRelation(relation);
  if (!targetId) { toast('Target item ID is required','error'); return; }
  confirmDialog(
    `Remove dependency ${rel}?`,
    `This will remove the ${rel} dependency between ${itemId} and ${targetId}.`,
    async () => {
      try {
        await api('DELETE', `/projects/${state.currentProject!.id}/pm/deps/${itemId}`, { targetId, rel });
        toast('Dependency removed','success');
        openItemDetail(itemId);
      } catch(err: unknown) { toastError(err); }
    },
    true
  );
}

/**
 * Records a learning typed into the detail modal on the item, requiring
 * non-empty text. On success it toasts confirmation and reopens the item
 * detail.
 */
export async function addLearning(itemId: string): Promise<void> {
  const el = document.getElementById('new-learning') as HTMLTextAreaElement | null;
  const text = el?.value?.trim() || '';
  if (!text) { toast('Learning text is required','error'); return; }
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/learnings/${itemId}`,{text});
    toast('Learning recorded','success');
    openItemDetail(itemId);
  } catch(err: unknown) { toastError(err); }
}

/**
 * Adds a test command (required) with an optional description to the item via
 * the tests endpoint. On success it toasts confirmation and reopens the item
 * detail.
 */
export async function addTest(itemId: string): Promise<void> {
  const cmdEl = document.getElementById('new-test-cmd') as HTMLInputElement | null;
  const descEl = document.getElementById('new-test-desc') as HTMLInputElement | null;
  const command = cmdEl?.value?.trim() || '';
  const description = descEl?.value?.trim() || '';
  if (!command) { toast('Test command is required','error'); return; }
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/tests/${itemId}`,{command,description});
    toast('Test added','success');
    openItemDetail(itemId);
  } catch(err: unknown) { toastError(err); }
}

/**
 * Links a file path (required) to the item via the files endpoint. On success
 * it toasts confirmation and reopens the item detail.
 */
export async function addFileLink(itemId: string): Promise<void> {
  const el = document.getElementById('file-path-input') as HTMLInputElement | null;
  const filePath = el?.value?.trim() || '';
  if (!filePath) { toast('File path is required','error'); return; }
  try {
    await api('POST',`/projects/${state.currentProject!.id}/pm/files/${itemId}`,{path:filePath});
    toast('File linked','success');
    openItemDetail(itemId);
  } catch(err: unknown) { toastError(err); }
}

// ═══════════════════════════════════════════════════════════════
// USE ITEM AS TEMPLATE
// ═══════════════════════════════════════════════════════════════
/**
 * Closes the item detail modal and opens the create view pre-filled from the
 * given item's fields, prefixing the title with "Copy of" and focusing and
 * selecting it so the user can immediately edit. The form is filled after a
 * short delay to let the create view render.
 */
export function useItemAsTemplate(item: Record<string, unknown>): void {
  // Close the item detail modal and navigate to create view
  hideModal('item-detail-modal');
  showView('create');
  // Give the create view time to render, then fill fields
  setTimeout(() => {
    // Pre-fill create form from item fields (title gets "Copy of …" prefix)
    const origTitle = String(item['title'] || '');
    setFormValue('ci-title', origTitle ? `Copy of ${origTitle}` : '');
    setFormValue('ci-type', String(item['type'] || ''));
    setFormValue('ci-priority', String(item['priority'] || ''));
    const tags = Array.isArray(item['tags']) ? (item['tags'] as string[]).join(', ') : String(item['tags'] || '');
    setFormValue('ci-tags', tags);
    setFormValue('ci-desc', String(item['description'] || ''));
    setFormValue('ci-sprint', String(item['sprint'] || ''));
    setFormValue('ci-release', String(item['release'] || ''));
    setFormValue('ci-assignee', String(item['assignee'] || ''));
    if (item['acceptance_criteria'] || item['acceptanceCriteria']) {
      setFormValue('ci-acceptance-criteria', String(item['acceptance_criteria'] || item['acceptanceCriteria'] || ''));
    }
    if (item['body']) {
      setFormValue('ci-body', String(item['body']));
    }
    document.getElementById('ci-title')?.focus();
    // Select all title text so user can immediately replace or refine
    const titleEl = document.getElementById('ci-title') as HTMLInputElement | null;
    titleEl?.select();
    toast('Create form pre-filled from item', 'success');
  }, 150);
}
