// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════
import { PRIORITY_LABELS, TYPE_ICONS } from './constants.js';

/** Escape characters with HTML entity meaning so a value can be inserted into
 * markup without injection. Falsy input yields an empty string. */
export function escHtml(s: string | undefined | null): string {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** Build a colored status-badge span for an item status, mapping the
 * `in_progress` code to "In Progress" and CSS-classifying the rest by slug. */
export function statusBadge(s: string): string {
  const labels: Record<string, string> = { in_progress: 'In Progress' };
  const status = String(s || 'unknown');
  const classSuffix = status.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  return `<span class="status-badge status-${classSuffix}">${escHtml(labels[status] || status)}</span>`;
}

/** Render a priority indicator span (P0–P4) whose color class and tooltip
 * label come from the PRIORITY_LABELS lookup table. */
export function priorityDot(p: number): string {
  return `<span class="priority-dot priority-${p}" title="P${p}: ${PRIORITY_LABELS[p]||''}"></span>`;
}

/** Render an item-type glyph span using the TYPE_ICONS map, falling back to
 * the middle-dot character when the type has no assigned icon. */
export function typeIcon(t: string): string {
  return `<span class="item-type-icon" title="${t}">${TYPE_ICONS[t]||'·'}</span>`;
}

/** Format a timestamp as a short relative phrase ("just now", "5m ago",
 * "3h ago", "2d ago") or, past a week, a localized calendar date. Falsy or
 * unparseable input returns an empty string. */
export function relTime(ts: string | undefined | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff/1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  if (s < 604800) return `${Math.floor(s/86400)}d ago`;
  return d.toLocaleDateString();
}

/** Format a timestamp as a US-style short date (e.g. "Jan 5, 2026"). Falsy
 * input returns an empty string. */
export function fmtDate(ts: string | undefined | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
}

/** Toggle a button's disabled state and, when `text` is supplied, update the
 * button label — replacing the first inner span when present, otherwise the
 * whole text content. */
export function setLoading(btn: HTMLButtonElement, yes: boolean, text?: string): void {
  btn.disabled = yes;
  if (text) {
    const span = btn.querySelector('span');
    if (span) span.textContent = text;
    else btn.textContent = text;
  }
}

/** Build an HTML string of `n` placeholder skeleton rows for loading states. */
export function skeletonRows(n = 5): string {
  return Array.from({length: n}, () => '<div class="skeleton skeleton-row"></div>').join('');
}

/** Build an HTML string of `n` placeholder skeleton cards for loading states. */
export function skeletonCards(n = 3): string {
  return Array.from({length: n}, () => '<div class="skeleton skeleton-card"></div>').join('');
}
