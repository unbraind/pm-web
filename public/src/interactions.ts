/** Add keyboard semantics to legacy delegated actions and label generated form controls. */
export function initInteractions(): void {
  /** Enhance newly mounted views without replacing elements or moving focus. */
  const enhance = (): void => {
    document.querySelectorAll<HTMLElement>('[onclick]').forEach(el => {
      if (!el.matches('button,a,input,select,textarea,[tabindex]')) {
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
      }
    });
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type="hidden"]),select,textarea').forEach(el => {
      if (el.id) {
        const label = el.closest('.form-group')?.querySelector('label');
        if (label && !label.htmlFor) label.htmlFor = el.id;
      }
      if (!el.labels?.length && !el.getAttribute('aria-label')) el.setAttribute('aria-label', el.getAttribute('placeholder')?.replace(/…/g, '') || el.id.replace(/-/g, ' ') || 'Filter');
    });
    document.querySelectorAll<HTMLButtonElement>('button').forEach(el => {
      if (el.classList.contains('modal-close')) el.setAttribute('aria-label', 'Close dialog');
    });
  };
  document.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLElement) {
      const el = event.target;
      if (el.matches('[role="button"][onclick]') && !el.matches('button,a') && (event.key === ' ' || !el.hasAttribute('onkeydown'))) { event.preventDefault(); el.click(); }
    }
  });
  enhance();
  new MutationObserver(enhance).observe(document.body, { childList: true, subtree: true });
}
