// ═══════════════════════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════
import type { ToastType } from '../types.js';

/** Show a transient toast notification of the given type, appending it to the
 * toast container and removing it after 3.5 seconds. */
export function toast(msg: string, type: ToastType = 'info'): void {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  const container = document.getElementById('toast-container');
  if (container) container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
