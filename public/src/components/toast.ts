// ═══════════════════════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════
import type { ToastType } from '../types.js';

export function toast(msg: string, type: ToastType = 'info'): void {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  const container = document.getElementById('toast-container');
  if (container) container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
