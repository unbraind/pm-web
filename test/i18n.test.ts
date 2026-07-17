import assert from "node:assert/strict";
import test, { before } from "node:test";
import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Package root: test/ compiles to dist-test/, so go up one level from there.
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const i18nDir = path.join(packageRoot, "public", "src", "i18n");
const i18nSrc = path.join(packageRoot, "public", "src", "i18n.ts");

const enJson = JSON.parse(
  readFileSync(path.join(i18nDir, "en.json"), "utf8"),
) as Record<string, string>;
const deJson = JSON.parse(
  readFileSync(path.join(i18nDir, "de.json"), "utf8"),
) as Record<string, string>;
const esJson = JSON.parse(
  readFileSync(path.join(i18nDir, "es.json"), "utf8"),
) as Record<string, string>;
// All shipped catalogs keyed by locale code, so parity/coverage tests can
// loop generically over every locale instead of hard-coding each one.
const allCatalogs: Record<string, Record<string, string>> = {
  en: enJson,
  de: deJson,
  es: esJson,
};
const nonEnLocales = Object.keys(allCatalogs).filter((l) => l !== "en");
const indexHtml = readFileSync(
  path.join(packageRoot, "public", "index.html"),
  "utf8",
);

// Compile i18n.ts (which has no imports/side effects at module top level) into a
// temp dir so the pure helpers (resolveLocale, translate, translateError) can
// be imported and exercised directly — mirroring the static-scripts test,
// which builds its TypeScript sources in a before() hook.
const tmpOut = path.join(packageRoot, ".i18n-test-build");

interface LocaleStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  clear(): void;
  key(i: number): string | null;
  length: number;
}

interface I18nModule {
  resolveLocale(opts?: { storage?: LocaleStorage | null; navLang?: string }): string;
  translate(
    catalog: Record<string, string>,
    fallback: Record<string, string>,
    key: string,
    params?: Record<string, string | number>,
  ): string;
  translateError(message: string): string;
  setLocale(locale: string): Promise<void>;
  getLocale(): string;
  t(key: string, params?: Record<string, string | number>): string;
}

let i18n: I18nModule | null = null;

before(() => {
  const tscBin = path.join(
    packageRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  rmSync(tmpOut, { recursive: true, force: true });
  mkdirSync(tmpOut, { recursive: true });
  execFileSync(
    process.execPath,
    [
      tscBin,
      i18nSrc,
      "--target",
      "ES2022",
      "--module",
      "ES2022",
      "--moduleResolution",
      "bundler",
      "--lib",
      "ES2022,DOM,DOM.Iterable",
      "--strict",
      "--outDir",
      tmpOut,
      "--ignoreConfig",
    ],
    {
      cwd: packageRoot,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  // Dynamic import (ESM) of the freshly compiled module.
  const url = pathToFileURL(path.join(tmpOut, "i18n.js")).href;
  return import(url).then((m: I18nModule) => {
    i18n = m;
  });
});

// ── Catalog parity: every en key must exist in every shipped locale with a non-empty value ──
test("catalog parity: every en key exists in every locale with a non-empty value", () => {
  const enKeys = Object.keys(enJson).sort();
  assert.ok(enKeys.length > 0, "en.json should not be empty");
  for (const loc of nonEnLocales) {
    const cat = allCatalogs[loc];
    const missing: string[] = [];
    const empty: string[] = [];
    for (const key of enKeys) {
      if (!(key in cat)) {
        missing.push(key);
      } else if (!String(cat[key]).trim()) {
        empty.push(key);
      }
    }
    assert.deepEqual(missing, [], `${loc}.json is missing keys: ${missing.join(", ")}`);
    assert.deepEqual(empty, [], `${loc}.json has empty values for: ${empty.join(", ")}`);
  }
});

// ── No extra locale keys that aren't in en (keep en as source of truth) ──
test("no locale has keys absent from en (en is the source of truth)", () => {
  for (const loc of nonEnLocales) {
    const extra = Object.keys(allCatalogs[loc]).filter((k) => !(k in enJson));
    assert.deepEqual(extra, [], `${loc}.json has keys not in en.json: ${extra.join(", ")}`);
  }
});

// ── Translations are actually translated (differ from English) ───────────
test("non-en translations differ from en for non-structural strings", () => {
  // Keys whose values are intentionally identical across locales (proper
  // nouns, brand, code tokens, language-option labels, technical terms,
  // and pure punctuation placeholders).
  const structural = new Set([
    "settings.languageEn",
    "settings.languageDe",
    "settings.languageEs",
    "auth.placeholder.email",
    "auth.placeholder.password",
    "settings.tokenPlaceholder.set",
    "settings.tokenLabel",
  ]);
  for (const loc of nonEnLocales) {
    const cat = allCatalogs[loc];
    const same: string[] = [];
    for (const key of Object.keys(enJson)) {
      if (structural.has(key)) continue;
      if (enJson[key] === cat[key]) same.push(key);
    }
    assert.deepEqual(
      same,
      [],
      `${loc} value equals en for (translation looks untranslated): ${same.join(", ")}`,
    );
  }
});

// ── Locale resolution order ─────────────────────────────────────────────
test("resolveLocale: explicit storage choice wins", () => {
  const store = (val: string | null) => ({
    getItem: (k: string) => (k === "pmLocale" ? val : null),
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  });
  assert.equal(i18n!.resolveLocale({ storage: store("de"), navLang: "en-US" }), "de");
  assert.equal(i18n!.resolveLocale({ storage: store("en"), navLang: "de-DE" }), "en");
});

test("resolveLocale: navigator.language prefix match when no stored choice", () => {
  const empty = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  assert.equal(i18n!.resolveLocale({ storage: empty, navLang: "de-DE" }), "de");
  assert.equal(i18n!.resolveLocale({ storage: empty, navLang: "de" }), "de");
  assert.equal(i18n!.resolveLocale({ storage: empty, navLang: "en-US" }), "en");
  assert.equal(i18n!.resolveLocale({ storage: empty, navLang: "es-MX" }), "es");
  assert.equal(i18n!.resolveLocale({ storage: empty, navLang: "es" }), "es");
});

test("resolveLocale: unsupported navigator language falls back to en", () => {
  const empty = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  assert.equal(i18n!.resolveLocale({ storage: empty, navLang: "fr-FR" }), "en");
  // Explicit null means "skip this source" — both skipped falls back to en.
  assert.equal(i18n!.resolveLocale({ storage: null, navLang: null }), "en");
  assert.equal(i18n!.resolveLocale({ storage: null, navLang: "" }), "en");
});

test("resolveLocale: unsupported stored value is ignored", () => {
  const bad = {
    getItem: () => "fr",
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  assert.equal(i18n!.resolveLocale({ storage: bad, navLang: "de-DE" }), "de");
});

// ── t()/translate fallback + params ─────────────────────────────────────
test("translate: returns de value when present", () => {
  assert.equal(
    i18n!.translate(deJson, enJson, "auth.title.login"),
    deJson["auth.title.login"],
  );
});

test("translate: falls back to en when de key missing", () => {
  assert.equal(
    i18n!.translate({}, enJson, "auth.title.login"),
    enJson["auth.title.login"],
  );
});

test("translate: returns the key itself when missing from both catalogs", () => {
  assert.equal(i18n!.translate({}, {}, "nope.does.not.exist"), "nope.does.not.exist");
});

test("translate: substitutes {param} placeholders", () => {
  assert.equal(
    i18n!.translate(deJson, enJson, "auth.oidc.template", { label: "Acme" }),
    "Mit Acme fortfahren",
  );
  assert.equal(
    i18n!.translate({}, enJson, "settings.accountCreated", { date: "2026" }),
    "Account created 2026",
  );
  assert.equal(
    i18n!.translate(deJson, enJson, "settings.accountCreated", { date: "2026" }),
    "Konto erstellt am 2026",
  );
});

// ── Error mapping (display layer) ───────────────────────────────────────
test("error.* English values are unique so the reverse map is unambiguous", () => {
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  for (const [key, value] of Object.entries(enJson)) {
    if (!key.startsWith("error.")) continue;
    const prev = seen.get(value);
    if (prev !== undefined) {
      dupes.push(`${prev} === ${key} (${JSON.stringify(value)})`);
    } else {
      seen.set(value, key);
    }
  }
  assert.deepEqual(dupes, [], `duplicate error.* English values: ${dupes.join("; ")}`);
});

test("translateError: unknown message is returned unchanged (fallback)", () => {
  // No catalog has been fetched in this Node context, so the reverse map is
  // empty and any unknown message must pass through verbatim.
  assert.equal(i18n!.translateError("Something completely unexpected"), "Something completely unexpected");
});

test("translateError: every error.* key has a translation in every locale", () => {
  for (const loc of nonEnLocales) {
    const cat = allCatalogs[loc];
    const missing: string[] = [];
    for (const key of Object.keys(enJson)) {
      if (!key.startsWith("error.")) continue;
      if (!cat[key] || !String(cat[key]).trim()) missing.push(key);
    }
    assert.deepEqual(missing, [], `untranslated error keys in ${loc}: ${missing.join(", ")}`);
  }
});

// ── Functional check: auth screen renders German when pmLocale=de ────────
//
// Simulate applyTranslations() on index.html using the de catalog, then verify
// the auth-screen block contains no English defaults for package-owned strings.
function authScreenBlock(html: string): string {
  const start = html.indexOf('id="auth-screen"');
  const end = html.indexOf('id="main-app"');
  assert.ok(start !== -1 && end !== -1, "index.html should have auth-screen and main-app sections");
  return html.slice(start, end);
}

function simulateTextBindings(html: string, catalog: Record<string, string>): string {
  // Replace visible text bound via data-i18n="key">…</… with the catalog value.
  return html.replace(
    /data-i18n="([^"]+)"([^>]*)>([^<]*)</g,
    (_m, key: string, _attrs: string, _text: string) => {
      const val = catalog[key] ?? _text;
      return `data-i18n="${key}"${_attrs}>${val}<`;
    },
  );
}

test("functional: auth screen renders German when de catalog is applied", () => {
  const block = authScreenBlock(indexHtml);
  const rendered = simulateTextBindings(block, deJson);

  // Sanity: the auth-screen wires these keys.
  assert.match(block, /data-i18n="auth\.title\.login"/, "auth title wired");
  assert.match(block, /data-i18n="auth\.button\.login"/, "auth button wired");
  assert.match(block, /data-i18n="auth\.brand\.tagline"/, "tagline wired");

  // After applying de, the German strings should be present.
  assert.ok(rendered.includes(deJson["auth.title.login"]), "auth title is German");
  assert.ok(rendered.includes(deJson["auth.button.login"]), "auth button is German");
  assert.ok(rendered.includes(deJson["auth.brand.tagline"]), "tagline is German");

  // And the English defaults must no longer be visible on the auth screen.
  const englishLeftovers = [
    "Welcome back",
    "Sign In",
    "Sign in to your account to continue",
    "Create account",
    "Join pm-web",
    "Continue with OpenID Connect",
    "Git-native project management",
    "Manage tasks, features, bugs",
  ].filter((phrase) => rendered.includes(phrase));
  assert.deepEqual(
    englishLeftovers,
    [],
    `English auth strings still visible after de applied: ${englishLeftovers.join(", ")}`,
  );
});

test("functional: every data-i18n key wired in index.html has a translation in every locale", () => {
  const keys = new Set<string>();
  const re = /data-i18n(?:-html|-title|-placeholder|-aria)?="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(indexHtml)) !== null) keys.add(m[1]);
  assert.ok(keys.size > 0, "index.html should wire data-i18n keys");
  for (const loc of nonEnLocales) {
    const cat = allCatalogs[loc];
    const missing = [...keys].filter((k) => !cat[k] || !String(cat[k]).trim());
    assert.deepEqual(missing, [], `wired keys without ${loc} translation: ${missing.join(", ")}`);
  }
});

// ── First-paint hint: browser-language negotiation in index.html ─────────
//
// The inline head script must set <html lang> from the browser language when
// no pmLocale is stored, mirroring resolveLocale()'s navigator prefix match.
test("index.html first-paint hint negotiates navigator.language when no stored locale", () => {
  // Extract the inline script block.
  const m = indexHtml.match(/<script>([^<]*localStorage\.getItem[^<]*)<\/script>/);
  assert.ok(m, "index.html should contain the first-paint locale script");
  const src = m![1];
  // Helper that runs the hint script against a fake document/language/store.
  function runHint(stored: string | null, navLang: string): string {
    let htmlLang = 'en';
    const fakeDoc = { documentElement: { set lang(v: string) { htmlLang = v; }, get lang() { return htmlLang; } } };
    const fakeStore = { getItem: (k: string) => (k === 'pmLocale' ? stored : null) };
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      'localStorage', 'navigator', 'document',
      `try{${src}}catch(e){}`,
    );
    fn(fakeStore, { language: navLang }, fakeDoc);
    return htmlLang;
  }
  // Persisted preference takes precedence.
  assert.equal(runHint('de', 'en-US'), 'de');
  assert.equal(runHint('en', 'de-DE'), 'en');
  assert.equal(runHint('es', 'en-US'), 'es');
  // No stored choice → browser-language prefix match (German → de, Spanish → es).
  assert.equal(runHint(null, 'de-DE'), 'de');
  assert.equal(runHint(null, 'de'), 'de');
  assert.equal(runHint(null, 'es-MX'), 'es');
  assert.equal(runHint(null, 'es'), 'es');
  // Unsupported browser language → stays at default en.
  assert.equal(runHint(null, 'fr-FR'), 'en');
  assert.equal(runHint(null, 'en-US'), 'en');
});

// ── localStorage hardening: storage access must not abort startup ───────
//
// Privacy/incognito modes can throw SecurityError on localStorage access.
// resolveLocale must catch these and continue with fallbacks rather than
// reject and prevent the app from rendering.
test("resolveLocale: throwing storage.getItem falls back to navigator language", () => {
  const throwingGet: LocaleStorage = {
    getItem: () => { throw new Error("SecurityError: storage blocked"); },
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  // getItem throws → caught → falls through to navLang prefix match → 'de'.
  assert.equal(i18n!.resolveLocale({ storage: throwingGet, navLang: 'de-DE' }), 'de');
  // No usable navLang → default 'en' (no throw).
  assert.equal(i18n!.resolveLocale({ storage: throwingGet, navLang: 'fr-FR' }), 'en');
});

test("resolveLocale: safeLocalStorage getter throwing does not abort (no opts)", () => {
  // Simulate a browser privacy mode where resolving the localStorage
  // reference itself throws. The no-argument path uses safeLocalStorage()
  // internally and must not throw — it continues with fallbacks. The exact
  // fallback depends on the host's navigator.language (which varies by
  // environment), so we only assert it returns a supported locale and never
  // throws, which is the real contract being hardened.
  const g = globalThis as unknown as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(g, 'localStorage');
  const prev = g.localStorage;
  Object.defineProperty(g, 'localStorage', {
    configurable: true,
    get() { throw new Error("SecurityError: localStorage blocked"); },
  });
  try {
    const resolved = i18n!.resolveLocale();
    assert.ok(
      resolved === 'en' || resolved === 'de',
      `resolveLocale should return a supported locale without throwing, got ${resolved}`,
    );
  } finally {
    delete g.localStorage;
    if (had) g.localStorage = prev;
  }
});

test("setLocale: throwing storage.setItem does not abort the locale switch", async () => {
  const realFetch = globalThis.fetch;
  // setLocale only needs an en catalog; stub fetch to return it immediately.
  globalThis.fetch = (() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(enJson),
  })) as unknown as typeof fetch;
  const g = globalThis as unknown as Record<string, unknown>;
  const prevLS = g.localStorage;
  // A storage that throws on writes (privacy-mode write block).
  g.localStorage = {
    getItem: () => null,
    setItem: () => { throw new Error("SecurityError: write blocked"); },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  try {
    // Must not reject despite setItem throwing.
    await i18n!.setLocale('en');
    assert.equal(i18n!.getLocale(), 'en');
  } finally {
    g.localStorage = prevLS;
    globalThis.fetch = realFetch;
  }
});

// ── Stale catalog fetch guard (rapid de → en) ───────────────────────────
//
// When two setLocale calls overlap, the earlier (slower) fetch must be
// discarded so it can never overwrite the newer selection.
test("setLocale: stale catalog fetch is discarded when a newer setLocale wins", async () => {
  const realFetch = globalThis.fetch;
  let deResolve: ((v: { ok: boolean; json: () => Promise<Record<string, string>> }) => void) | undefined;
  globalThis.fetch = ((input: unknown) => {
    const url = String(input);
    if (url.endsWith('/en.json')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(enJson) });
    }
    if (url.endsWith('/de.json')) {
      // Deferred: resolves only when we trigger it, simulating a slow fetch.
      return new Promise((resolve) => { deResolve = resolve as typeof deResolve; });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }) as unknown as typeof fetch;

  try {
    // Pre-load the en fallback so both race calls skip the en fetch and go
    // straight to their (possibly deferred) active-catalog fetch.
    await i18n!.setLocale('en');

    // Start the German selection — its de fetch is deferred (pending).
    const dePromise = i18n!.setLocale('de');
    // Immediately switch to en; en needs no fetch (activeCatalog = enCatalog).
    await i18n!.setLocale('en');

    // Release the stale German fetch.
    assert.ok(deResolve, 'de fetch should have been requested');
    deResolve!({ ok: true, json: () => Promise.resolve(deJson) });
    await dePromise;

    // The latest selection (en) must win: locale is en, catalog is English.
    assert.equal(i18n!.getLocale(), 'en');
    assert.equal(i18n!.t('auth.title.login'), enJson['auth.title.login']);
    // German must NOT have leaked through the stale fetch.
    assert.notEqual(i18n!.t('auth.title.login'), deJson['auth.title.login']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Dialog button localization catalog keys ─────────────────────────────
test("dialog.* catalog keys exist and are localized in every locale", () => {
  for (const key of ['dialog.cancel', 'dialog.confirm', 'dialog.delete']) {
    assert.ok(enJson[key], `en.json missing ${key}`);
    for (const loc of nonEnLocales) {
      const cat = allCatalogs[loc];
      assert.ok(cat[key], `${loc}.json missing ${key}`);
      assert.notEqual(enJson[key], cat[key], `${key} should differ between en and ${loc}`);
    }
  }
});