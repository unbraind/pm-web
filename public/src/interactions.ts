/** Add keyboard semantics to legacy delegated actions and label generated form controls. */
export function initInteractions(): void {
  /** Enhance newly mounted views without replacing elements or moving focus. */
  const enhance = (): void => {
    const dialogs = [...document.querySelectorAll<HTMLElement>('.modal-backdrop')].filter(el => el.checkVisibility());
    const scope = dialogs.at(-1) || [...document.querySelectorAll<HTMLElement>('.content-area,#auth-screen')].find(el => el.checkVisibility());
    if (scope) {
      const primaries = [...scope.querySelectorAll<HTMLElement>('.btn-primary,[data-primary-action]')].filter(el => el.checkVisibility() && !el.matches(':disabled,[aria-disabled="true"]'));
      primaries.forEach((el, index) => {
        el.dataset.primaryAction = 'true';
        el.classList.toggle('btn-primary', index === 0);
        el.classList.toggle('btn-secondary', index !== 0);
      });
    }
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
    document.querySelectorAll<HTMLElement>('.page-title,.auth-form-title,.item-detail-title').forEach(el => {
      el.setAttribute('role', 'heading');
      el.setAttribute('aria-level', el.classList.contains('item-detail-title') ? '2' : '1');
    });
  };
  document.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLElement) {
      const el = event.target;
      if (el.matches('[role="button"][onclick]') && !el.matches('button,a') && (event.key === ' ' || !el.hasAttribute('onkeydown'))) { event.preventDefault(); el.click(); }
    }
  });
  document.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('[aria-disabled="true"]')) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  enhance();
  new MutationObserver(enhance).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'aria-disabled'] });
}
