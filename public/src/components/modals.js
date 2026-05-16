// ═══════════════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════════════
import { escHtml } from '../utils.js';
export function showModal(id) {
    const modal = document.getElementById(id);
    if (modal)
        modal.style.display = 'flex';
}
export function hideModal(id) {
    const modal = document.getElementById(id);
    if (modal)
        modal.style.display = 'none';
}
export function closeAllModals() {
    document.querySelectorAll('.modal-backdrop').forEach(m => {
        m.style.display = 'none';
    });
}
export function createModal(id, title, bodyHtml, footerHtml, wide = false) {
    let existing = document.getElementById(id);
    if (existing)
        existing.remove();
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
    el.addEventListener('click', e => { if (e.target === el)
        hideModal(id); });
    const container = document.getElementById('modal-container');
    if (container)
        container.appendChild(el);
    return el;
}
export function confirmDialog(title, desc, onConfirm, danger = false) {
    const id = 'confirm-dialog-' + Date.now();
    createModal(id, '', `
    <div class="confirm-dialog">
      <div class="confirm-dialog-icon">${danger ? '⚠' : '?'}</div>
      <div class="confirm-dialog-title">${escHtml(title)}</div>
      <div class="confirm-dialog-desc">${escHtml(desc)}</div>
      <div class="confirm-dialog-actions">
        <button class="btn btn-ghost" onclick="window.__app.hideModal('${id}')">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="${id}-ok">${danger ? 'Delete' : 'Confirm'}</button>
      </div>
    </div>`, '');
    showModal(id);
    document.getElementById(`${id}-ok`)?.addEventListener('click', () => {
        hideModal(id);
        onConfirm();
    });
}
//# sourceMappingURL=modals.js.map