// ═══════════════════════════════════════════════════════════════
// COOKIE CONSENT BANNER — pm-web
//
// This is the TypeScript source for /cookie-consent.js. It is compiled
// with the `DOM` lib (see public/tsconfig.scripts.json) and emitted as
// a classic browser script (no import/export) so it can be loaded via
// `<script src="/cookie-consent.js">` without a module loader. The IIFE
// keeps the global scope clean.
// ═══════════════════════════════════════════════════════════════

(() => {
  const STORAGE_KEY = 'pm_cookie_preferences_v1';
  const banner = document.getElementById('cookie-consent');
  const links = document.querySelectorAll<HTMLElement>('[data-cookie-settings]');

  type CookieChoice = 'acknowledged' | 'necessary';

  interface CookiePreferences {
    necessary: true;
    optional: false;
    choice: CookieChoice;
    savedAt: string;
  }

  function save(choice: CookieChoice): void {
    const preferences: CookiePreferences = {
      necessary: true,
      optional: false,
      choice,
      savedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      /* ignore unavailable storage */
    }
  }

  function hasChoice(): boolean {
    try {
      return Boolean(localStorage.getItem(STORAGE_KEY));
    } catch {
      return false;
    }
  }

  function show(event?: Event): void {
    if (event) event.preventDefault();
    if (banner) banner.hidden = false;
  }

  function hide(): void {
    if (banner) banner.hidden = true;
  }

  links.forEach((link) => {
    link.addEventListener('click', show);
  });

  document.querySelectorAll<HTMLElement>('[data-cookie-accept], [data-cookie-decline]').forEach((button) => {
    button.addEventListener('click', () => {
      save(button.hasAttribute('data-cookie-accept') ? 'acknowledged' : 'necessary');
      hide();
    });
  });

  if (!hasChoice()) show();
})();