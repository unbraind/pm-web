// ═══════════════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════════════
import { escHtml } from '../utils.js';

export function showModal(id: string): void {
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'flex';
}

export function hideModal(id: string): void {
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'none';
}

export function closeAllModals(): void {
  document.querySelectorAll('.modal-backdrop').forEach(m => {
    (m as HTMLElement).style.display = 'none';
  });
}

export function createModal(
  id: string,
  title: string,
  bodyHtml: string,
  footerHtml: string,
  wide = false
): HTMLElement {
  let existing = document.getElementById(id);
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = id;
  el.className = 'modal-backdrop';
  el.style.display = 'none';
  el.innerHTML = `
    <div class="modal${wide ? ' modal-wide' : ''}">
      <div class="modal-header">
        <div class="modal-title">${escHtml(title)}</div>
        <button class="modal-close" onclick="window.__app.hideModal('${id}')">&times;</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
    </div>`;
  el.addEventListener('click', e => { if (e.target === el) hideModal(id); });
  const container = document.getElementById('modal-container');
  if (container) container.appendChild(el);
  return el;
}

export function confirmDialog(
  title: string,
  desc: string,
  onConfirm: () => void,
  danger = false,
  labels?: { cancel?: string; confirm?: string },
): void {
  const id = 'confirm-dialog-' + Date.now();
  const cancelLabel = labels?.cancel ?? 'Cancel';
  const confirmLabel = labels?.confirm ?? (danger ? 'Delete' : 'Confirm');
  createModal(id, '', `
    <div class="confirm-dialog">
      <div class="confirm-dialog-icon">${danger ? '⚠' : '?'}</div>
      <div class="confirm-dialog-title">${escHtml(title)}</div>
      <div class="confirm-dialog-desc">${escHtml(desc)}</div>
      <div class="confirm-dialog-actions">
        <button class="btn btn-ghost" onclick="window.__app.hideModal('${id}')">${escHtml(cancelLabel)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="${id}-ok">${escHtml(confirmLabel)}</button>
      </div>
    </div>`
  , '');
  showModal(id);
  document.getElementById(`${id}-ok`)?.addEventListener('click', () => {
    hideModal(id);
    onConfirm();
  });
}
