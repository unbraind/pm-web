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
  const UI_CONFIG_URL = '/api/ui-config';
  /** The operator's deployed cookie-settings legal page (overlay-served). */
  const OPERATOR_COOKIE_SETTINGS_URL = '/cookie-settings';
  const banner = document.getElementById('cookie-consent');

  type CookieChoice = 'acknowledged' | 'necessary';

  interface CookiePreferences {
    necessary: true;
    optional: false;
    choice: CookieChoice;
    savedAt: string;
  }

  /**
   * Read whether the operator kept the built-in storage notice enabled.
   *
   * The server exposes the `PM_WEB_STORAGE_NOTICE` setting through the
   * unauthenticated `GET /api/ui-config` endpoint. Any failure — network
   * error, non-OK response, unparsable body, or a missing/invalid field —
   * falls back to `true` (enabled), so a broken read never silently hides
   * a legal notice. The promise therefore always resolves and never throws.
   */
  async function readStorageNotice(): Promise<boolean> {
    try {
      const response = await fetch(UI_CONFIG_URL);
      if (!response.ok) return true;
      const config = JSON.parse(await response.text()) as { storageNotice?: unknown };
      return config.storageNotice !== false;
    } catch {
      return true;
    }
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

  /**
   * Enable the built-in storage notice: the documented package behaviour.
   * The `[data-cookie-settings]` controls open the banner, the accept and
   * decline buttons persist a choice, and the banner auto-shows once for
   * visitors without a recorded choice.
   */
  function enableNotice(): void {
    document.querySelectorAll<HTMLElement>('[data-cookie-settings]').forEach((link) => {
      link.addEventListener('click', show);
    });

    document.querySelectorAll<HTMLElement>('[data-cookie-accept], [data-cookie-decline]').forEach((button) => {
      button.addEventListener('click', () => {
        save(button.hasAttribute('data-cookie-accept') ? 'acknowledged' : 'necessary');
        hide();
      });
    });

    if (!hasChoice()) show();
  }

  /**
   * The operator's own consent manager is authoritative instead.
   *
   * The banner must never show and nothing is ever written to
   * `pm_cookie_preferences_v1`, so the package never records a choice that
   * belongs to the operator's deployment. `[data-cookie-settings]` buttons
   * would open a banner that stays hidden, so each falls back to a plain
   * link to the operator's deployed cookie-settings legal page (served from
   * the operator's legal overlay when one is configured).
   */
  function deferToOperator(): void {
    hide();
    document.querySelectorAll<HTMLElement>('[data-cookie-settings]').forEach((control) => {
      const link = document.createElement('a');
      link.href = OPERATOR_COOKIE_SETTINGS_URL;
      link.className = control.className;
      const label = control.getAttribute('aria-label');
      if (label) link.setAttribute('aria-label', label);
      link.textContent = control.textContent;
      control.replaceWith(link);
    });
  }

  void readStorageNotice().then((enabled) => {
    if (enabled) enableNotice();
    else deferToOperator();
  });
})();
