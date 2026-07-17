// ═══════════════════════════════════════════════════════════════
// i18n — locale resolution, catalog lookup, DOM binding
// ═══════════════════════════════════════════════════════════════
//
// Flat JSON catalogs (one file per locale) live alongside this module in
// `public/src/i18n/{en,de}.json`. They are fetched at runtime so the browser
// bundle stays free of new build-time dependencies and the same JSON files
// can be audited by tests directly. The English catalog is the source of
// truth: every key must exist in `en.json`; other locales fall back to it.
//
// Scope: this module covers *package-owned* SPA UI strings (auth screen, nav,
// banners, settings incl. registration acknowledgement, consent UI). Server
// API error strings stay English on the wire and are translated at the
// display layer via `translateError()` (fallback: raw message).
//
// Legal pages (`public/*.html`) are operator-overlay templates
// (`PM_WEB_LEGAL_DIR`); their localization is an operator concern and is NOT
// handled here. The language selector deliberately does not promise
// translated legal pages — see `settings.languageHint` and the German
// disclaimer string `legal.disclaimer`.

/** localStorage key persisting the user's locale choice. */
export const LOCALE_STORAGE_KEY = 'pmLocale';

/** Locales shipped by this package. The first entry is the default/fallback. */
export const SUPPORTED_LOCALES = ['en', 'de'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const DEFAULT_LOCALE: SupportedLocale = 'en';

/**
 * Resolve the active locale without touching the DOM, so it is unit-testable
 * in Node. Resolution order:
 *   1. `opts.storage[LOCALE_STORAGE_KEY]` (explicit user choice)
 *   2. `opts.navLang` prefix match against SUPPORTED_LOCALES (e.g. `de-DE` → `de`)
 *   3. default locale (`en`)
 *
 * `opts.storage` may be `null` to skip the localStorage step; `opts.navLang`
 * may be omitted to skip navigator negotiation. When called with no
 * arguments the real browser globals (`localStorage`, `navigator.language`)
 * are used — but only inside this function, never at module top level, so
 * importing this module in Node has no side effects.
 */
export function resolveLocale(opts?: {
  storage?: Storage | null;
  navLang?: string;
}): SupportedLocale {
  // A property that is present (even if `null`) means the caller explicitly
  // wants that value: `null` skips the step. A property that is absent falls
  // back to the real browser global, so the no-argument browser path still
  // works. This keeps the function deterministic and unit-testable in Node.
  const hasStorage = opts != null && Object.prototype.hasOwnProperty.call(opts, 'storage');
  const storage = hasStorage ? opts!.storage : safeLocalStorage();
  if (storage) {
    let stored: string | null = null;
    try { stored = storage.getItem(LOCALE_STORAGE_KEY); } catch { /* privacy mode */ }
    if (stored && isSupported(stored)) return stored;
  }
  const hasNav = opts != null && Object.prototype.hasOwnProperty.call(opts, 'navLang');
  const navLang = hasNav ? opts!.navLang : safeNavLang();
  if (navLang) {
    const prefix = navLang.toLowerCase().split('-')[0];
    if (prefix && isSupported(prefix)) return prefix;
  }
  return DEFAULT_LOCALE;
}

function isSupported(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** localStorage access guarded so Node imports/tests never crash.
 * Resolving the storage reference itself can throw a `SecurityError` in
 * privacy/incognito modes that disable storage, so the lookup is wrapped too. */
function safeLocalStorage(): Storage | null {
  try {
    const g = globalThis as { localStorage?: Storage };
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

/** navigator.language access guarded so Node imports/tests never crash. */
function safeNavLang(): string | undefined {
  const n = (globalThis as { navigator?: { language?: string } }).navigator;
  return n?.language;
}

/**
 * Pure catalog lookup with fallback. Used by `t()` and directly by tests.
 *
 * @param catalog   the active locale catalog (may be partial)
 * @param fallback  the fallback catalog (English — must contain every key)
 * @param key       dotted string id
 * @param params    optional `{name: value}` substitutions for `{name}` tokens
 * @returns the translated string, or the key itself if missing from both
 */
export function translate(
  catalog: Record<string, string>,
  fallback: Record<string, string>,
  key: string,
  params?: Record<string, string | number>,
): string {
  let raw = catalog[key] ?? fallback[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      raw = raw.replaceAll(`{${name}}`, String(value));
    }
  }
  return raw;
}

// ── Runtime state (populated by initI18n / setLocale) ───────────────
let currentLocale: SupportedLocale = DEFAULT_LOCALE;
let activeCatalog: Record<string, string> = {};
let enCatalog: Record<string, string> = {};
let initialized = false;

/**
 * Monotonic request id for setLocale. Each invocation increments this; an
 * in-flight request records its id and, after its awaited catalog fetch,
 * commits state only if it is still the latest. This discards stale catalogs
 * when language changes overlap (e.g. rapid de → en) so a slower earlier
 * fetch can never overwrite a newer selection.
 */
let localeReqId = 0;

/** Fetch a locale catalog JSON. Best-effort: returns {} on any failure. */
async function fetchCatalog(locale: string): Promise<Record<string, string>> {
  try {
    const res = await fetch(`/src/i18n/${locale}.json`, { credentials: 'same-origin' });
    if (!res.ok) return {};
    const data = (await res.json()) as Record<string, string>;
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** Apply the resolved locale to `<html lang>` so AT/browsers report it. */
function syncHtmlLang(locale: string): void {
  const el = (globalThis as { document?: Document }).document?.documentElement;
  if (el) el.lang = locale;
}

/**
 * Initialize i18n: resolve the locale, load the English fallback + the active
 * catalog, set `<html lang>`, and apply `data-i18n` bindings in the document.
 * Safe to call once at boot; subsequent calls re-apply translations.
 */
export async function initI18n(): Promise<void> {
  if (!initialized) {
    currentLocale = resolveLocale();
  }
  if (!Object.keys(enCatalog).length) {
    enCatalog = await fetchCatalog('en');
  }
  if (currentLocale === 'en') {
    activeCatalog = enCatalog;
  } else {
    activeCatalog = await fetchCatalog(currentLocale);
  }
  initialized = true;
  syncHtmlLang(currentLocale);
  applyTranslations();
}

/** Current active locale. */
export function getLocale(): SupportedLocale {
  return currentLocale;
}

/**
 * Translate a key using the active locale with English fallback. Requires
 * `initI18n()` to have completed; before that, returns the English value (or
 * the key if English is also missing).
 */
export function t(
  key: string,
  params?: Record<string, string | number>,
): string {
  return translate(activeCatalog, enCatalog, key, params);
}

/**
 * Persist a new locale choice, load its catalog, update `<html lang>`, and
 * re-apply `data-i18n` bindings across the document. Falls back to `en` for
 * unsupported values.
 */
export async function setLocale(locale: string): Promise<void> {
  const next: SupportedLocale = isSupported(locale) ? locale : DEFAULT_LOCALE;
  const storage = safeLocalStorage();
  if (storage) { try { storage.setItem(LOCALE_STORAGE_KEY, next); } catch { /* privacy mode */ } }
  currentLocale = next;
  const myReqId = ++localeReqId;
  if (!Object.keys(enCatalog).length) {
    const en = await fetchCatalog('en');
    // A newer setLocale superseded this one: do not assign enCatalog.
    if (myReqId !== localeReqId) return;
    enCatalog = en;
  }
  const fetched = next === 'en' ? enCatalog : await fetchCatalog(next);
  // Stale request: discard the fetched catalog so it can never overwrite a
  // newer selection (e.g. a slow German fetch finishing after en was chosen).
  if (myReqId !== localeReqId) return;
  activeCatalog = fetched;
  initialized = true;
  syncHtmlLang(next);
  applyTranslations();
}

/**
 * Walk the document for `data-i18n` attributes and bind translations. Three
 * attribute flavors are supported:
 *   - `data-i18n="key"`           → sets `textContent`
 *   - `data-i18n-html="key"`     → sets `innerHTML` (for strings with markup)
 *   - `data-i18n-title="key"`    → sets the `title` attribute
 *   - `data-i18n-placeholder="key"` → sets the `placeholder` attribute
 *   - `data-i18n-aria="key"`      → sets the `aria-label` attribute
 *
 * `data-i18n-params` may carry a JSON object literal for parameterized keys.
 */
export function applyTranslations(root?: ParentNode): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return;
  const scope = root ?? doc;
  bindAttr(scope, '[data-i18n]', 'data-i18n', (el, v) => { el.textContent = v; });
  bindAttr(scope, '[data-i18n-html]', 'data-i18n-html', (el, v) => { el.innerHTML = v; });
  bindAttr(scope, '[data-i18n-title]', 'data-i18n-title', (el, v) => { el.setAttribute('title', v); });
  bindAttr(scope, '[data-i18n-placeholder]', 'data-i18n-placeholder', (el, v) => { el.setAttribute('placeholder', v); });
  bindAttr(scope, '[data-i18n-aria]', 'data-i18n-aria', (el, v) => { el.setAttribute('aria-label', v); });
}

function bindAttr(
  scope: ParentNode,
  selector: string,
  attr: string,
  setter: (el: Element, value: string) => void,
): void {
  scope.querySelectorAll<Element>(selector).forEach((el) => {
    const key = el.getAttribute(attr);
    if (!key) return;
    const paramsJson = el.getAttribute('data-i18n-params');
    const params = paramsJson ? safeParseParams(paramsJson) : undefined;
    setter(el, t(key, params));
  });
}

function safeParseParams(json: string): Record<string, string | number> | undefined {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string | number>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map a known server error message (English, as sent on the wire) to the
 * active locale's catalog. Unknown messages are returned unchanged so the
 * user always sees something meaningful. This is the display-layer
 * translation boundary for API/OIDC errors.
 */
export function translateError(message: string): string {
  const reverse = errorReverseMap();
  const key = reverse.get(message);
  if (key) return t(key);
  return message;
}

// Lazy reverse map: English error text → catalog key. Built from enCatalog
// so it tracks the catalog without a hand-maintained second table.
let cachedErrorReverse: Map<string, string> | null = null;
function errorReverseMap(): Map<string, string> {
  if (cachedErrorReverse) return cachedErrorReverse;
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(enCatalog)) {
    if (key.startsWith('error.')) map.set(value, key);
  }
  cachedErrorReverse = map;
  return map;
}

/**
 * Format a date in the active locale (`de-DE` for de, `en-US` for en) using
 * Intl.DateTimeFormat. Replaces hard-coded `toLocaleDateString('en-US', …)`.
 */
export function localeDate(
  date: Date | string | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  const localeTag = currentLocale === 'de' ? 'de-DE' : 'en-US';
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat(localeTag, options).format(d);
}