/**
 * Replay-privacy and sign-in analytics contract for the served HTML.
 *
 * pm-web renders private project, item and account data. Session-replay tools
 * run by an opt-in analytics deployment honour the `data-umami-block`
 * attribute, so every container that fills with private content must carry it
 * and the sign-in screen stays unblocked. Operators must configure and verify
 * input masking in their replay tool. Sign-in start clicks are marked with
 * the `data-umami-event` attribute API so operators can count them without
 * any script changes.
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
import { after, before, test } from "node:test";
import vm from "node:vm";
import { buildSync } from "esbuild";
import { buildStaticScripts, type StaticScripts, publicDir } from "./helpers/public-scripts.ts";

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

/** Minimal element double exposing only the two methods the tab helper uses. */
class AttributeStub {
  /** Attributes assigned through `setAttribute`. */
  readonly attributes = new Map<string, string>();

  /** Record an attribute write. */
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /** Remove an attribute. */
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

/** Read a served page from the public directory, asserting it exists. */
function readPublicPage(name: string): string {
  const file = path.join(publicDir, name);
  assert.ok(existsSync(file), `${name} should exist in public/`);
  return readFileSync(file, "utf8");
}

let scripts: StaticScripts;
after(() => { scripts?.cleanup(); });

before(() => {
  // The branding scan also covers the built classic script browsers load.
  scripts = buildStaticScripts();
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
    "the sign-in screen stays visible; operators must configure and verify input masking",
  );
});

test("replay guidance requires operators to configure and verify input masking", () => {
  for (const page of ["index.html", "privacy-policy.html"]) {
    const html = readPublicPage(page);
    assert.match(html, /operators must configure and verify input masking/i, `${page} must explain the operator's masking responsibility`);
  }
  for (const page of VISITOR_PAGES) {
    assert.doesNotMatch(readPublicPage(page), /inputs are masked by replay tools|masked.{0,40}(?:anyway|automatically|by default)/i, `${page} must not promise configuration-independent input masking`);
  }
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
  const script = readFileSync(scripts.cookieConsentOutputPath, "utf8");
  const stripped = script.replace(/data-umami-[a-z-]+/g, "");
  assert.doesNotMatch(stripped, /umami/i, "cookie-consent.js must not name the analytics vendor");
});

test("the shared submit button reports a sign-in start only on the sign-in tab", () => {
  // Execute the actual tab-switch function, with its UI dependencies scoped
  // to this realm. This catches a missing call as well as a broken helper.
  const button = new AttributeStub();
  const module = { exports: {} as { switchAuthTab?: (tab: "login" | "register") => void } };
  const dependencies: Record<string, unknown> = {
    "../state.js": { state: { authTab: "login" } },
    "../api.js": {},
    "../app.js": {},
    "../i18n.js": { t: (key: string): string => key },
  };
  let present = true;
  const context = vm.createContext({
    module,
    require: (id: string): unknown => {
      assert.ok(Object.hasOwn(dependencies, id), `unexpected auth import: ${id}`);
      return dependencies[id];
    },
    document: { getElementById: (id: string): AttributeStub | null => present && id === "auth-submit" ? button : null },
  });
  const compiled = buildSync({
    entryPoints: [path.join(publicDir, "src", "views", "auth.ts")],
    bundle: true,
    write: false,
    format: "cjs",
    target: "es2022",
    external: Object.keys(dependencies),
  }).outputFiles[0].text;
  new vm.Script(compiled, { filename: "auth.js" }).runInContext(context);
  const { exports } = module;
  assert.ok(exports.switchAuthTab);
  exports.switchAuthTab("login");
  assert.equal(button.attributes.get("data-umami-event"), "auth_sign_in_started");
  assert.equal(button.attributes.get("data-umami-event-provider"), "password");
  exports.switchAuthTab("register");
  assert.equal(button.attributes.has("data-umami-event"), false);
  assert.equal(button.attributes.has("data-umami-event-provider"), false);
  exports.switchAuthTab("login");
  assert.equal(button.attributes.get("data-umami-event"), "auth_sign_in_started");
  assert.equal(button.attributes.get("data-umami-event-provider"), "password");
  present = false;
  assert.doesNotThrow(() => exports.switchAuthTab?.("register"));
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
