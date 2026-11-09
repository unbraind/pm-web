/**
 * Replay-privacy and sign-in analytics contract for the served HTML.
 *
 * pm-web renders private project, item and account data. Session-replay tools
 * run by an opt-in analytics deployment honour the `data-umami-block`
 * attribute, so every container that fills with private content must carry it
 * and the sign-in screen must NOT (its inputs are masked by replay tools
 * anyway). Sign-in start clicks are marked with the `data-umami-event`
 * attribute API so operators can count them without any script changes.
 *
 * These tests parse the actual served `public/index.html` (and the other
 * visitor-visible pages) rather than the TypeScript sources: removing any
 * attribute from the served markup fails here even if the source keeps it,
 * and the branding scan keeps the analytics vendor's name out of everything a
 * visitor can see (only the `data-umami-*` attribute API may carry it).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { buildStaticScripts, cookieConsentOutputPath, publicDir } from "./helpers/public-scripts.ts";

/** Containers the application fills with signed-in or private content. */
const PRIVATE_CONTAINERS = [
  "main-app",
  "modal-container",
  "toast-container",
  "live-copy-announcement",
] as const;

/** Visitor-visible pages scanned by the branding rule. */
const VISITOR_PAGES = [
  "index.html",
  "legal-notice.html",
  "privacy-policy.html",
  "terms.html",
  "cookie-settings.html",
] as const;

/** Extract an element's opening tag from HTML by its id, or return null. */
function openTagById(html: string, id: string): string | null {
  const match = html.match(new RegExp(`<([a-z]+)([^>]*\\bid="${id}"[^>]*)>`, "i"));
  return match ? `<${match[1]}${match[2]}>` : null;
}

/** All attribute occurrences of the tracker attribute API in a document. */
function trackerAttributeTokens(source: string): string[] {
  return [...source.matchAll(/data-umami-[a-z-]+/g)].map((match) => match[0]);
}

/** Read a served page from the public directory, asserting it exists. */
function readPublicPage(name: string): string {
  const file = path.join(publicDir, name);
  assert.ok(existsSync(file), `${name} should exist in public/`);
  return readFileSync(file, "utf8");
}

before(() => {
  // The branding scan also covers the built classic script browsers load.
  buildStaticScripts();
});

test("every private-content container in index.html carries data-umami-block", () => {
  const html = readPublicPage("index.html");
  for (const id of PRIVATE_CONTAINERS) {
    const tag = openTagById(html, id);
    assert.ok(tag, `index.html should contain #${id}`);
    assert.match(
      tag,
      /data-umami-block/,
      `#${id} renders item, project, user or token data and must stay out of session replays`,
    );
  }
});

test("the sign-in screen stays unblocked for session replays", () => {
  const html = readPublicPage("index.html");
  const tag = openTagById(html, "auth-screen");
  assert.ok(tag, "index.html should contain #auth-screen");
  assert.doesNotMatch(
    tag,
    /data-umami-block/,
    "the sign-in screen must remain visible in replays; its inputs are masked by replay tools",
  );
});

test("sign-in start buttons carry click-event attributes with a fixed provider, never user data", () => {
  const html = readPublicPage("index.html");
  const submit = openTagById(html, "auth-submit");
  assert.ok(submit, "index.html should contain #auth-submit");
  assert.match(submit, /data-umami-event="auth_sign_in_started"/, "password submit marks the sign-in start");
  assert.match(submit, /data-umami-event-provider="password"/, "password submit names the provider");

  const oidc = openTagById(html, "oidc-login");
  assert.ok(oidc, "index.html should contain #oidc-login");
  assert.match(oidc, /data-umami-event="auth_sign_in_started"/, "single sign-on marks the sign-in start");
  assert.match(oidc, /data-umami-event-provider="oidc"/, "single sign-on names the provider");

  // No user name, e-mail, token, or URL may leak into an attribute value:
  // the only tracker attributes in the page are the fixed event ones above.
  for (const token of [...html.matchAll(/data-umami-(event(?:-[a-z-]+)?)="([^"]*)"/g)]) {
    assert.ok(
      ["event", "event-provider"].includes(token[1]),
      `unexpected tracker attribute ${token[1]}`,
    );
    assert.doesNotMatch(token[2], /[@:]/, `attribute value must not carry user data: ${token[2]}`);
  }
});

test("dynamically created private overlays set the replay-privacy attribute themselves", () => {
  // Graph context menu, graph tooltips, the dependency modals inserted
  // directly on <body>, and the offline-recovery notices all render private
  // data outside the blocked #main-app region, so each must mark itself.
  const graph = readFileSync(path.join(publicDir, "src", "views", "graph.ts"), "utf8");
  assert.match(graph, /setAttribute\('data-umami-block'/, "graph context menu must self-mark");
  assert.match(graph, /id="graph-add-dep-modal"[^>]*data-umami-block/, "add-dependency modal must self-mark");
  assert.match(graph, /id="graph-remove-dep-modal"[^>]*data-umami-block/, "remove-dependency modal must self-mark");
  const canvas = readFileSync(path.join(publicDir, "src", "views", "graph-canvas.ts"), "utf8");
  assert.match(canvas, /setAttribute\('data-umami-block'/, "graph tooltip must self-mark");
  const recovery = readFileSync(path.join(publicDir, "src", "offline-recovery.ts"), "utf8");
  assert.equal(
    (recovery.match(/setAttribute\('data-umami-block'/g) ?? []).length,
    2,
    "both offline-recovery notices must self-mark",
  );
});

test("no visitor-visible page or served script names the analytics vendor outside the data-umami attribute API", () => {
  for (const page of VISITOR_PAGES) {
    const html = readPublicPage(page);
    const stripped = html.replace(/data-umami-[a-z-]+/g, "");
    assert.doesNotMatch(stripped, /umami/i, `${page} must not name the analytics vendor visitor-visibly`);
  }
  const script = readFileSync(cookieConsentOutputPath, "utf8");
  const stripped = script.replace(/data-umami-[a-z-]+/g, "");
  assert.doesNotMatch(stripped, /umami/i, "cookie-consent.js must not name the analytics vendor");
});

test("tracker attribute tokens appear only as the documented attribute API", () => {
  const html = readPublicPage("index.html");
  for (const token of trackerAttributeTokens(html)) {
    assert.ok(
      ["data-umami-block", "data-umami-event", "data-umami-event-provider"].includes(token),
      `unexpected tracker token ${token}`,
    );
  }
});
