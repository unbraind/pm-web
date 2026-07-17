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

// ── Catalog parity: every en key must exist in de with a non-empty value ──
test("catalog parity: every en key exists in de with a non-empty value", () => {
  const enKeys = Object.keys(enJson).sort();
  assert.ok(enKeys.length > 0, "en.json should not be empty");
  const missing: string[] = [];
  const empty: string[] = [];
  for (const key of enKeys) {
    if (!(key in deJson)) {
      missing.push(key);
    } else if (!String(deJson[key]).trim()) {
      empty.push(key);
    }
  }
  assert.deepEqual(missing, [], `de.json is missing keys: ${missing.join(", ")}`);
  assert.deepEqual(empty, [], `de.json has empty values for: ${empty.join(", ")}`);
});

// ── No extra de keys that aren't in en (keep en as source of truth) ──────
test("de has no keys absent from en (en is the source of truth)", () => {
  const extra = Object.keys(deJson).filter((k) => !(k in enJson));
  assert.deepEqual(extra, [], `de.json has keys not in en.json: ${extra.join(", ")}`);
});

// ── German translations are actually German (differ from English) ────────
test("de translations differ from en for non-structural strings", () => {
  const same: string[] = [];
  for (const key of Object.keys(enJson)) {
    // Skip values that are intentionally identical across locales (proper
    // nouns, brand, code tokens, the language-option labels, technical terms,
    // and pure punctuation placeholders).
    if (
      key === "settings.languageEn" ||
      key === "settings.languageDe" ||
      key === "auth.placeholder.email" ||
      key === "auth.placeholder.password" ||
      key === "settings.tokenPlaceholder.set" ||
      key === "settings.tokenLabel"
    ) {
      continue;
    }
    if (enJson[key] === deJson[key]) same.push(key);
  }
  assert.deepEqual(
    same,
    [],
    `de value equals en for (translation looks untranslated): ${same.join(", ")}`,
  );
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

test("translateError: every error.* key has a German translation", () => {
  const missing: string[] = [];
  for (const key of Object.keys(enJson)) {
    if (!key.startsWith("error.")) continue;
    if (!deJson[key] || !String(deJson[key]).trim()) missing.push(key);
  }
  assert.deepEqual(missing, [], `untranslated error keys: ${missing.join(", ")}`);
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

test("functional: every data-i18n key wired in index.html has a de translation", () => {
  const keys = new Set<string>();
  const re = /data-i18n(?:-html|-title|-placeholder|-aria)?="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(indexHtml)) !== null) keys.add(m[1]);
  assert.ok(keys.size > 0, "index.html should wire data-i18n keys");
  const missing = [...keys].filter((k) => !deJson[k] || !String(deJson[k]).trim());
  assert.deepEqual(missing, [], `wired keys without de translation: ${missing.join(", ")}`);
});