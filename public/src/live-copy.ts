import { isRecentOwnItemEdit } from './edit-origin.js';
import { api } from './api.js';
import { state } from './state.js';
import { escHtml, fmtDate, relTime, statusBadge } from './utils.js';
import type { Item, User, PresenceUser, Comment, HistoryEntry } from './types.js';
import type { ItemResponse, ListResponse, CommentsResponse, HistoryResponse } from './api-types.js';

/** Additive identity metadata accepted from both API and committed-history SSE events. */
export interface LiveUpdate {
  itemId?: string;
  userId?: string;
  author?: string;
  sessionId?: string;
  surface?: string;
}

type LiveEntry = Comment & HistoryEntry;
interface LiveRecord extends Item { comments?: LiveEntry[]; history?: LiveEntry[] }
const authors = new Map<string, string>();
const pending = new Map<string, number>();
const fieldTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>[]>();
let nextRevision = 0;
const captionTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

/** Ignore malformed or oversized identities without rejecting legacy payloads. */
export function parseLiveUpdate(raw: string): LiveUpdate | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const result: LiveUpdate = {};
    for (const key of ['itemId', 'userId', 'author', 'sessionId', 'surface'] as const) {
      const value = (data as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim() && value.length <= 256) result[key] = value.trim();
    }
    return result;
  } catch { return null; }
}

/** Prefer authenticated ids; unknown origins refresh quietly and own sessions never animate. */
export function isOtherAuthor(event: LiveUpdate, user: User, sessionId: string | null): boolean {
  if (event.sessionId && event.sessionId === sessionId) return false;
  if (event.userId) return event.userId !== user.id;
  if (!event.author) return false;
  const own = [user.id, user.email, user.display_name || ''].map(value => value.trim().toLowerCase());
  return !own.includes(event.author.trim().toLowerCase());
}

/** Retain project-scoped display names for older servers that send only user ids. */
export function rememberLiveAuthors(users: PresenceUser[]): void {
  authors.clear();
  users.forEach(user => authors.set(user.userId, user.displayName));
}

/** Cancel stale responses when leaving a project; no DOM or focus is replaced. */
export function resetLiveCopies(): void {
  pending.clear();
  authors.clear();
  captionTimers.forEach(clearTimeout);
  captionTimers.clear();
  fieldTimers.forEach((timers, field) => {
    timers.forEach(clearTimeout);
    clearFieldCopy(field);
  });
  fieldTimers.clear();
  document.querySelectorAll<HTMLElement>('[data-live-caption]').forEach(el => { el.textContent = ''; });
  const region = document.getElementById('live-copy-announcement');
  if (region) region.textContent = '';
}

/** Remove a visual duplicate without replacing the accessible source nodes. */
function clearFieldCopy(field: HTMLElement): void {
  field.classList.remove('live-changed', 'live-copy-cover');
  field.querySelectorAll(':scope > .live-copy-sheet').forEach(copy => copy.remove());
  const source = field.querySelector(':scope > .live-field-source');
  if (source) source.replaceWith(...source.childNodes);
}

/** Render readonly comment/history entries independently of the surrounding draft form. */
export function liveCollectionMarkup(kind: 'comments' | 'history', rows: LiveEntry[]): string {
  if (!rows.length) return `<p class="live-empty">No ${kind} yet</p>`;
  return rows.map(row => `<div class="live-collection-entry" data-live-entry="${escHtml(entryKey(row))}" data-entry-value="${escHtml(JSON.stringify(row))}">${entryMarkup(row)}</div>`).join('');
}

/** Physical indices distinguish history entries even when mutations share a timestamp. */
function entryKey(row: LiveEntry): string {
  return row.index === undefined ? row.timestamp || row.created_at || row.text || row.content || row.body || row.message || row.action || '' : `history:${row.index}`;
}

/** Display actionable history errors instead of an empty-history success state. */
export function historyFailure(error: unknown): string {
  const response = error && typeof error === 'object' && 'response' in error ? error.response : undefined;
  const remedy = response && typeof response === 'object' && 'remedy' in response ? String(response.remedy) : 'Refresh this view to try again.';
  return `${error instanceof Error ? error.message : 'History could not be loaded.'} ${remedy}`;
}

/** Reset to the newest page on open/live refresh; older-page responses cannot overwrite a newer read. */
export function setHistoryPage(root: HTMLElement, page: HistoryResponse, projectId: string, itemId: string, render = true): void {
  const collection = root.querySelector<HTMLElement>('[data-live-field="history"]');
  const button = root.querySelector<HTMLButtonElement>('[data-history-older]');
  if (!collection || !button) return;
  const rows = [...page.history].reverse();
  const revision = String(Number(button.dataset.revision || 0) + 1);
  button.dataset.revision = revision;
  if (render) {
    collection.innerHTML = liveCollectionMarkup('history', rows);
    collection.dataset.liveValue = JSON.stringify(rows);
  }
  button.hidden = !page.has_more;
  button.disabled = false;
  button.textContent = 'Load older history';
  const status = root.querySelector<HTMLElement>('[data-history-status]');
  if (status) status.textContent = '';
  button.onclick = async () => {
    if (!page.next_cursor || button.disabled) return;
    button.disabled = true;
    try {
      const older = await api<HistoryResponse>('GET', `/projects/${projectId}/pm/history/${encodeURIComponent(itemId)}?cursor=${encodeURIComponent(page.next_cursor)}`);
      if (!root.isConnected || state.currentProject?.id !== projectId || button.dataset.revision !== revision) return;
      collection.insertAdjacentHTML('beforeend', liveCollectionMarkup('history', [...older.history].reverse()));
      // Retain loaded rows while continuing backwards from the older page.
      page = { ...older, history: [...older.history, ...page.history] };
      collection.dataset.liveValue = JSON.stringify([...page.history].reverse());
      button.hidden = !older.has_more;
    } catch (error) {
      if (button.dataset.revision === revision && status) status.textContent = historyFailure(error);
    } finally {
      if (button.dataset.revision === revision) button.disabled = false;
    }
  };
}

/** Escape readable activity content while retaining the data typography. */
function entryMarkup(row: LiveEntry): string {
  return `<time>${escHtml(fmtDate(row.timestamp || row.created_at))}</time><p>${escHtml(row.text || row.content || row.body || row.message || row.action || 'Activity recorded')}</p>`;
}

/** Keep existing collection nodes and their slots stable, including a removal receipt. */
function reconcileCollection(field: HTMLElement, rows: LiveEntry[]): void {
  field.querySelector('.live-empty')?.remove();
  const existing = new Map([...field.querySelectorAll<HTMLElement>('[data-live-entry]')].map(row => [row.dataset.liveEntry!, row]));
  const history = field.dataset.liveField === 'history';
  let previous: Element | null = null;
  for (const entry of rows) {
    const key = entryKey(entry);
    const row = existing.get(key);
    if (row) {
      if (row.dataset.entryValue !== JSON.stringify(entry)) { row.innerHTML = entryMarkup(entry); row.dataset.entryValue = JSON.stringify(entry); }
      existing.delete(key);
    } else {
      field.insertAdjacentHTML('beforeend', liveCollectionMarkup('comments', [entry]));
    }
    if (history) {
      const current = row || field.lastElementChild!;
      field.insertBefore(current, previous ? previous.nextSibling : field.firstChild);
      previous = current;
    }
  }
  existing.forEach(row => { if (history) row.remove(); else { row.textContent = 'Entry removed'; row.dataset.entryValue = ''; } });
}

/** Store canonical field values separately from their readable labels. */
export function liveFieldValue(field: string, item: LiveRecord): string {
  if (field === 'strip') return `${item.id} · ${item.type || 'Item'} · P${item.priority ?? 4}`;
  if (field === 'acceptanceCriteria') return item.acceptanceCriteria || item.acceptance_criteria || '';
  if (field === 'detailStatus') return item.status || 'draft';
  if (field === 'blockedReason') return item.blockedReason || item['blocked-reason'] || '';
  if (field === 'comments' || field === 'history') return JSON.stringify(item[field] || []);
  const value = item[field as keyof Item];
  return Array.isArray(value) ? value.join(', ') : String(value ?? '');
}

/** Update one readonly value, keeping its node, reserved geometry and neighboring controls. */
function writeField(field: HTMLElement, item: LiveRecord, value: string): void {
  const name = field.dataset.liveField;
  if (name === 'comments' || name === 'history') reconcileCollection(field, item[name] || []);
  else if (name === 'detailStatus') field.innerHTML = value === 'closed' ? '<span class="closed-stamp">Closed</span>' : statusBadge(value);
  else if (name === 'tags' && field.classList.contains('item-tags')) {
    field.innerHTML = (item.tags || []).map(tag => `<span class="tag">${escHtml(tag)}</span>`).join('');
  } else {
    const display = name === 'deadline' ? fmtDate(value) : name === 'priority' ? `P${value || '—'}` : name === 'updated_at' ? relTime(value) : name === 'blockedReason' ? (value ? `Blocked: ${value}` : '') : name === 'status' ? value.replace(/_/g, ' ') : value;
    field.textContent = display || (name === 'description' ? 'No description yet' : '—');
  }
  if (name === 'comments') {
    const tab = field.closest('.modal-body')?.querySelector<HTMLElement>('.tab[onclick*="tab-comments"]');
    if (tab) tab.textContent = `Comments (${item.comments?.length || 0})`;
  }
  if (name === 'status') {
    [...field.classList].filter(name => name.startsWith('status-') && name !== 'status-badge').forEach(name => field.classList.remove(name));
    field.classList.add(`status-${String(item.status || 'draft').replace(/[^a-z0-9_-]/gi, '-')}`);
  }
  field.dataset.liveValue = value;
}

/** Refresh lifecycle action availability and show Reopen for finished items. */
export function refreshActionState(root: HTMLElement, item: Item): void {
  root.querySelectorAll<HTMLElement>('[data-item-action]').forEach(action => {
    const kind = action.dataset.itemAction;
    const finished = ['closed', 'canceled'].includes(item.status || '');
    const enabled = kind === 'release' ? true : kind === 'reopen' ? finished : kind === 'start' ? item.status === 'open' : kind === 'pause' ? item.status === 'in_progress' : !finished;
    action.hidden = kind === 'reopen' ? !finished : finished && ['start', 'pause', 'claim'].includes(kind || '');
    action.setAttribute('aria-disabled', String(!enabled));
    action.title = enabled ? '' : `This action is unavailable for a ${String(item.status || 'draft').replace(/_/g, ' ')} item. Change its status in Update first.`;
  });
}

/** Slide a duplicate over a fixed field, then leave its copy border for five seconds. */
function tintField(field: HTMLElement, blocked: boolean, origin: string): void {
  field.style.setProperty('--live-copy-ink', `var(--pm-${blocked ? 'rose' : 'canary'})`);
  field.style.setProperty('--live-copy-wash', `var(--pm-${blocked ? 'rose' : 'canary'}-wash)`);
  field.style.setProperty('--live-copy-rest-bg', getComputedStyle(field).backgroundColor);
  field.style.setProperty('--live-copy-rest-ink', getComputedStyle(field).color);
  field.classList.add('live-changed');
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const source = document.createElement('span');
    source.className = 'live-field-source';
    source.append(...field.childNodes);
    field.appendChild(source);
    field.classList.add('live-copy-cover');
    const copy = document.createElement('span');
    copy.className = 'live-copy-sheet';
    copy.setAttribute('aria-hidden', 'true');
    copy.title = origin;
    copy.dataset.liveOrigin = origin;
    copy.innerHTML = source.innerHTML;
    copy.style.top = `${field.scrollTop}px`;
    copy.style.bottom = 'auto';
    copy.style.height = `${field.clientHeight}px`;
    field.appendChild(copy);
    copy.scrollTop = field.scrollTop;
    timers.push(setTimeout(() => {
      copy.remove();
      source.replaceWith(...source.childNodes);
      field.classList.remove('live-copy-cover');
    }, 700));
  }
  timers.push(setTimeout(() => { field.classList.remove('live-changed'); fieldTimers.delete(field); }, 5000));
  fieldTimers.set(field, timers);
}

/** Attribute changes inside each affected sheet and announce once without moving focus. */
function caption(roots: HTMLElement[], message: string, error = false, blocked = false, stamp?: string): void {
  for (const root of roots) {
    const target = root.querySelector<HTMLElement>('[data-live-caption]');
    if (!target) continue;
    target.textContent = stamp || message;
    target.title = message;
    target.dataset.error = String(error);
    target.style.setProperty('--live-copy-ink', `var(--pm-${blocked ? 'rose' : 'canary'})`);
    const timer = captionTimers.get(target);
    if (timer) clearTimeout(timer);
    captionTimers.set(target, setTimeout(() => { target.textContent = ''; captionTimers.delete(target); }, 5000));
  }
  const region = document.getElementById('live-copy-announcement');
  if (region) region.textContent = message;
}

/** Patch visible item sheets from authoritative reads, preserving drafts, focus and row order. */
export async function receiveLiveUpdate(raw: string, projectId: string, sessionId: string | null, eventType = ''): Promise<boolean> {
  const event = parseLiveUpdate(raw);
  const user = state.user;
  if (!event || !user || state.currentProject?.id !== projectId) return false;
  const visibleRoots = [...document.querySelectorAll<HTMLElement>('[data-item-id]')].filter(root => root.checkVisibility());
  const roots = event.itemId ? visibleRoots.filter(root => root.dataset.itemId === event.itemId) : visibleRoots;
  if (!roots.length) return false;
  const key = `${projectId}:${event.itemId || '*'}`;
  const revision = ++nextRevision;
  pending.set(key, revision);
  roots.forEach(root => pending.set(`${projectId}:${root.dataset.itemId}`, revision));
  const remote = isOtherAuthor(event, user, sessionId) && (Boolean(event.userId) || !event.itemId || !isRecentOwnItemEdit(projectId, event.itemId));
  const author = event.author || authors.get(event.userId || '') || 'Project member';
  const origin = `${author} · ${event.surface || 'shared workspace'}`;
  if (/item[-_]deleted/.test(eventType)) {
    if (remote) caption(roots, `Deleted by ${origin} just now. Refresh the list to remove this sheet.`);
    return true;
  }
  try {
    const list = event.itemId
      ? await api<ItemResponse>('GET', `/projects/${projectId}/pm/get/${encodeURIComponent(event.itemId)}`).then(data => [data.item || data as Item])
      : await api<ListResponse>('GET', `/projects/${projectId}/pm/list-all?limit=200`).then(data => data.items || []);
    if (state.currentProject?.id !== projectId || state.user?.id !== user.id || pending.get(key) !== revision) return true;
    const detail = roots.find(root => root.classList.contains('modal-body'));
    const detailItem = list.find(item => item.id === detail?.dataset.itemId);
    if (detailItem) {
      const [comments, history] = await Promise.all([
        api<CommentsResponse>('GET', `/projects/${projectId}/pm/comments/${encodeURIComponent(detailItem.id)}`),
        api<HistoryResponse>('GET', `/projects/${projectId}/pm/history/${encodeURIComponent(detailItem.id)}`),
      ]);
      (detailItem as LiveRecord).comments = comments.comments || [];
      (detailItem as LiveRecord).history = [...history.history].reverse();
      if (state.currentProject?.id === projectId && state.user?.id === user.id && pending.get(key) === revision && detail) setHistoryPage(detail, history, projectId, detailItem.id, false);
    }
    if (state.currentProject?.id !== projectId || state.user?.id !== user.id || pending.get(key) !== revision) return true;
    for (const item of list) {
      if (!item.id || !item.title || (pending.get(`${projectId}:${item.id}`) || 0) > revision) continue;
      state.items = state.items.map(previous => previous.id === item.id ? { ...previous, ...item } : previous);
      for (const root of roots.filter(root => root.dataset.itemId === item.id && root.isConnected && root.checkVisibility())) {
        const detailSheet = root.closest<HTMLElement>('#item-detail-modal');
        const showCopy = !detail || detailSheet === detail.closest('#item-detail-modal');
        let changed = false;
        for (const field of root.querySelectorAll<HTMLElement>('[data-live-field]')) {
          if (field.closest('[data-item-id]') !== root || (field.dataset.liveField !== 'detailStatus' && field.closest('.detail-status-slot'))) continue;
          const value = liveFieldValue(field.dataset.liveField || '', item);
          if (value === field.dataset.liveValue) continue;
          fieldTimers.get(field)?.forEach(clearTimeout);
          clearFieldCopy(field);
          writeField(field, item, value);
          changed = true;
          if (remote && field.checkVisibility() && showCopy) tintField(field, item.status === 'blocked', origin);
        }
        refreshActionState(root, item);
        if (changed && remote && showCopy) caption([detailSheet || root], `Updated by ${origin} just now`, false, item.status === 'blocked', `${origin} · now`);
      }
    }
    return true;
  } catch {
    if (state.currentProject?.id === projectId && state.user?.id === user.id) caption(roots, 'Live update failed. Refresh this view to try again.', true);
    return true;
  }
}

/** Preserve collaborators' untouched fields when an older edit draft is saved. */
export function changedDraftFields(baseline: Record<string, string>, draft: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== baseline[key] && (value !== '' || ['title', 'status', 'priority', 'tags', 'description'].includes(key))));
}
