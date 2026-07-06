import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const LEGAL_PAGES = [
  "legal-notice",
  "privacy-policy",
  "terms",
  "cookie-settings",
] as const;

function readPage(name: string): string {
  const file = path.join(PUBLIC_DIR, `${name}.html`);
  assert.ok(existsSync(file), `${name}.html should exist in public/`);
  return readFileSync(file, "utf8");
}

test("all legal pages exist and are well-formed HTML", () => {
  for (const name of LEGAL_PAGES) {
    const html = readPage(name);
    assert.match(html, /<!DOCTYPE html>/i, `${name} should start with DOCTYPE`);
    assert.match(html, /<\/html>/i, `${name} should close <html>`);
    assert.match(html, new RegExp(`<title>.*${name.replace("-", " ")}.*</title>`, "i"), `${name} should have a title`);
  }
});

test("legal pages link the shared stylesheet and legal-common.css", () => {
  for (const name of LEGAL_PAGES) {
    const html = readPage(name);
    assert.match(html, /href="\/styles\.css\?v=\d+"/, `${name} should load styles.css`);
    assert.match(html, /href="\/legal-common\.css\?v=\d+"/, `${name} should load legal-common.css`);
  }
});

test("legal pages include the cookie-consent banner and script", () => {
  for (const name of LEGAL_PAGES) {
    const html = readPage(name);
    assert.match(html, /id="cookie-consent"/, `${name} should embed the cookie-consent banner`);
    assert.match(html, /src="\/cookie-consent\.js\?v=\d+"/, `${name} should load cookie-consent.js`);
    assert.match(html, /data-cookie-accept/, `${name} should have an accept button`);
    assert.match(html, /data-cookie-decline/, `${name} should have a decline button`);
  }
});

test("legal pages cross-link each other via the legal-nav", () => {
  for (const name of LEGAL_PAGES) {
    const html = readPage(name);
    const others = LEGAL_PAGES.filter((n) => n !== name);
    for (const other of others) {
      assert.match(
        html,
        new RegExp(`href="/${other}"`),
        `${name} should link to ${other}`,
      );
    }
  }
});

test("cookie-consent.js exposes the expected behaviour", () => {
  const file = path.join(PUBLIC_DIR, "cookie-consent.js");
  assert.ok(existsSync(file), "cookie-consent.js should exist");
  const src = readFileSync(file, "utf8");
  // Persists the user choice to localStorage under a versioned key.
  assert.match(src, /pm_cookie_preferences_v1/, "should use a versioned storage key");
  // Hides the banner after a choice is made.
  assert.match(src, /data-cookie-accept/, "should bind the accept button");
  assert.match(src, /data-cookie-decline/, "should bind the decline button");
  // Only shows the banner automatically when no choice has been recorded yet.
  assert.match(src, /hasChoice\(\)/, "should check for an existing choice before auto-showing");
});

test("legal-common.css provides the legal shell layout", () => {
  const file = path.join(PUBLIC_DIR, "legal-common.css");
  assert.ok(existsSync(file), "legal-common.css should exist");
  const css = readFileSync(file, "utf8");
  assert.match(css, /\.legal-shell/, "should style .legal-shell");
  assert.match(css, /\.legal-nav/, "should style .legal-nav");
  assert.match(css, /\.legal-main/, "should style .legal-main");
  assert.match(css, /\.cookie-consent/, "should style the cookie-consent banner");
  assert.match(css, /@media/, "should include responsive rules");
});