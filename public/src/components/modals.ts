// ═══════════════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════════════
import { escHtml } from '../utils.js';

const returnFocus = new WeakMap<HTMLElement, HTMLElement>();
let keyboardBound = false;

/** Keep keyboard navigation inside the topmost open dialog and support Escape. */
function bindDialogKeyboard(): void {
  if (keyboardBound) return;
  keyboardBound = true;
  document.addEventListener('keydown', event => {
    const open = [...document.querySelectorAll<HTMLElement>('.modal-backdrop')].filter(el => el.style.display !== 'none').at(-1);
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); hideModal(open.id); return; }
    if (event.key !== 'Tab') return;
    const actions = [...open.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex="0"]')].filter(el => !!el.getClientRects().length && !el.matches(':disabled'));
    const first = actions[0], last = actions.at(-1);
    if (!first || !last) return;
    if (!open.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}

/** Display the modal with the given id by setting its display style to flex. */
export function showModal(id: string): void {
  const modal = document.getElementById(id);
  if (modal) {
    bindDialogKeyboard();
    if (document.activeElement instanceof HTMLElement) returnFocus.set(modal, document.activeElement);
    modal.style.display = 'flex';
    modal.querySelector<HTMLButtonElement>('.modal-close')?.focus({ preventScroll: true });
  }
}

/** Hide the modal with the given id by setting its display style to none. */
export function hideModal(id: string): void {
  const modal = document.getElementById(id);
  if (modal) {
    modal.style.display = 'none';
    const target = returnFocus.get(modal);
    if (target?.isConnected) target.focus({ preventScroll: true });
  }
}

/** Hide every modal backdrop element in the document by setting each to
 * display none. */
export function closeAllModals(): void {
  [...document.querySelectorAll<HTMLElement>('.modal-backdrop')].filter(modal => modal.style.display !== 'none').reverse().forEach(modal => hideModal(modal.id));
}

/** Build (or rebuild) a modal element with the given id, title, body, and
 * optional footer markup, append it under `#modal-container`, and wire its
 * backdrop-click-to-close behavior. Returns the created modal element. */
export function createModal(
  id: string,
  title: string,
  bodyHtml: string,
  footerHtml: string,
  wide = false
): HTMLElement {
  const existing = document.getElementById(id);
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = id;
  el.className = 'modal-backdrop';
  el.style.display = 'none';
  el.innerHTML = `
    <div class="modal${wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
      <div class="modal-header">
        <div class="modal-title" id="${id}-title">${escHtml(title)}</div>
        <button class="modal-close" aria-label="Close dialog" onclick="window.__app.hideModal('${id}')">&times;</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
    </div>`;
  el.addEventListener('click', e => { if (e.target === el) hideModal(id); });
  const container = document.getElementById('modal-container');
  if (container) container.appendChild(el);
  return el;
}

/** Open a confirmation modal with a title and description; when the user
 * clicks the confirm button the modal closes and `onConfirm` runs. The
 * `danger` flag switches the styling and default labels to a destructive
 * action, and `labels` overrides the button text. */
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
