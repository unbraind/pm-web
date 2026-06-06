// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════
import { PRIORITY_LABELS, TYPE_ICONS } from './constants.js';

export function escHtml(s: string | undefined | null): string {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function statusBadge(s: string): string {
  const labels: Record<string, string> = { in_progress: 'In Progress' };
  const status = String(s || 'unknown');
  const classSuffix = status.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  return `<span class="status-badge status-${classSuffix}">${escHtml(labels[status] || status)}</span>`;
}

export function priorityDot(p: number): string {
  return `<span class="priority-dot priority-${p}" title="P${p}: ${PRIORITY_LABELS[p]||''}"></span>`;
}

export function typeIcon(t: string): string {
  return `<span class="item-type-icon" title="${t}">${TYPE_ICONS[t]||'·'}</span>`;
}

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

export function fmtDate(ts: string | undefined | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
}

export function setLoading(btn: HTMLButtonElement, yes: boolean, text?: string): void {
  btn.disabled = yes;
  if (text) {
    const span = btn.querySelector('span');
    if (span) span.textContent = text;
    else btn.textContent = text;
  }
}

export function skeletonRows(n = 5): string {
  return Array.from({length: n}, () => '<div class="skeleton skeleton-row"></div>').join('');
}

export function skeletonCards(n = 3): string {
  return Array.from({length: n}, () => '<div class="skeleton skeleton-card"></div>').join('');
}
