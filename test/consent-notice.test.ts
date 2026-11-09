/**
 * Behavioural tests for the built cookie-consent script.
 *
 * The built `public/cookie-consent.js` is the artifact browsers actually run
 * on the SPA and the standalone legal pages, so this suite compiles it from
 * `public/src/cookie-consent.ts` first (same pipeline as
 * `test/static-scripts.test.ts`) and then executes it inside a `node:vm`
 * realm against a minimal fake DOM. That keeps the assertions behavioural —
 * what the visitor sees, what is stored, which elements are replaced —
 * rather than source-string matching, and it covers both
 * `PM_WEB_STORAGE_NOTICE` outcomes plus every fetch-failure fallback
 * (the client must never throw and never hide the notice on a broken read).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  buildStaticScripts,
  cookieConsentOutputPath,
} from "./helpers/public-scripts.ts";

/** Minimal element double: only the surface the built script touches. */
class FakeElement {
  /** Tag name supplied by the fake document factory. */
  readonly tag: string;
  /** Element id (mirrors the `id` attribute). */
  id = "";
  /** Banner visibility flag the script toggles. */
  hidden = false;
  /** Class list the settings-control fallback copies to the anchor. */
  className = "";
  /** Attributes map backing get/set/hasAttribute. */
  readonly attributes = new Map<string, string>();
  /** Registered listeners, keyed by event type. */
  readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
  /** Text content assigned by the script (or the fixture). */
  textContent = "";
  /** `href` assigned to the anchor the fallback link creates. */
  href = "";
  /** Element the script replaced this one with, when `replaceWith` ran. */
  replacedWith: FakeElement | null = null;

  constructor(tag: string) {
    this.tag = tag;
  }

  /** Record an attribute write; keep `id` mirrored for `#id` selectors. */
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
  }

  /** Read an attribute back, or `null` when absent (DOM contract). */
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  /** Report whether an attribute is present (used for the choice buttons). */
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  /** Register a listener for a later simulated click. */
  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  /** Replace this element (the operator-link fallback uses this). */
  replaceWith(other: FakeElement): void {
    this.replacedWith = other;
  }

  /** Dispatch a synthetic click through the registered listeners. */
  click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener({ preventDefault(): void { /* nothing */ } });
    }
  }
}

/** The fake DOM surface the built script observes. */
interface FakeDocument {
  getElementById(id: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
  createElement(tag: string): FakeElement;
}

/** Everything one script execution observed: storage, elements, requests. */
interface ScriptOutcome {
  /** Fake document the script ran against. */
  document: FakeDocument;
  /** Recorded localStorage writes, in order. */
  writes: Array<[string, string]>;
  /** Recorded fetch targets. */
  requests: string[];
}

/** Built script source, compiled once in the suite's before hook. */
let builtSource = "";

/** Build the fake page the script expects: banner, buttons, settings control. */
function makeDocument(): FakeDocument {
  const elements: FakeElement[] = [];
  const banner = new FakeElement("div");
  banner.setAttribute("id", "cookie-consent");
  banner.hidden = true;
  elements.push(banner);
  const settings = new FakeElement("button");
  settings.setAttribute("type", "button");
  settings.setAttribute("data-cookie-settings", "");
  settings.className = "btn btn-primary";
  settings.setAttribute("aria-label", "Open Cookie Settings");
  settings.textContent = "Open Cookie Settings";
  elements.push(settings);
  const accept = new FakeElement("button");
  accept.setAttribute("data-cookie-accept", "");
  elements.push(accept);
  const decline = new FakeElement("button");
  decline.setAttribute("data-cookie-decline", "");
  elements.push(decline);
  return {
    getElementById: (id: string) => elements.find((el) => el.id === id) ?? null,
    querySelectorAll: (selector: string): FakeElement[] => {
      const matched = new Set<FakeElement>();
      for (const part of selector.split(",").map((piece) => piece.trim())) {
        const byId = part.match(/^#([\w-]+)$/);
        const byAttribute = part.match(/^\[([\w-]+)\]$/);
        for (const el of elements) {
          if (byId && el.id === byId[1]) matched.add(el);
          if (byAttribute && el.hasAttribute(byAttribute[1])) matched.add(el);
        }
      }
      return [...matched];
    },
    createElement: (tag: string) => new FakeElement(tag),
  };
}

/**
 * Run the built script once against a fake page, returning what it did.
 *
 * @param options - How the `/api/ui-config` fetch behaves: a plain object for
 *   a JSON response, or an `Error` to simulate a network failure.
 * @param storedChoice - Value previously present in localStorage, or `null`.
 * @returns The observed fake document, storage writes, and requests.
 */
async function runConsentScript(
  options: { storageNotice: boolean } | { error: Error } | { httpStatus: number },
  storedChoice: string | null = null,
): Promise<ScriptOutcome> {
  const source = builtSource;
  const document = makeDocument();
  const writes: Array<[string, string]> = [];
  const requests: string[] = [];
  const store = new Map<string, string>();
  if (storedChoice !== null) store.set("pm_cookie_preferences_v1", storedChoice);
  const localStorage = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      writes.push([key, value]);
      store.set(key, value);
    },
  };
  const fetchImpl = (): Promise<{ ok: boolean; text: () => Promise<string> }> => {
    requests.push("/api/ui-config");
    if ("error" in options) return Promise.reject(options.error);
    if ("httpStatus" in options) {
      return Promise.resolve({ ok: false, text: () => Promise.resolve("Not found") });
    }
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ storageNotice: options.storageNotice })),
    });
  };
  const context = vm.createContext({ document, localStorage, fetch: fetchImpl });
  new vm.Script(source, { filename: "cookie-consent.js" }).runInContext(context);
  // Flush the config read's promise chain (microtasks + one macrotask tick).
  await new Promise((resolve) => { setImmediate(resolve); });
  return { document, writes, requests };
}

/** The banner element of a fake page. */
function bannerOf(outcome: ScriptOutcome): FakeElement {
  const banner = outcome.document.getElementById("cookie-consent");
  assert.ok(banner, "banner element should exist");
  return banner;
}

test.before(() => {
  buildStaticScripts();
  builtSource = readFileSync(cookieConsentOutputPath, "utf8");
  assert.ok(builtSource.includes("pm_cookie_preferences_v1"), "built source should be the consent script");
});

test("storage notice on (default): banner shows once, a choice is persisted, buttons work", async () => {
  const outcome = await runConsentScript({ storageNotice: true });
  const banner = bannerOf(outcome);
  assert.equal(banner.hidden, false, "no recorded choice means the banner auto-shows");
  const accept = outcome.document.querySelectorAll("[data-cookie-accept]")[0];
  accept.click();
  assert.equal(banner.hidden, true, "accept hides the banner");
  assert.equal(outcome.writes.length, 1, "exactly one storage write");
  const [key, value] = outcome.writes[0];
  assert.equal(key, "pm_cookie_preferences_v1");
  const parsed = JSON.parse(value) as { choice: string; necessary: boolean; optional: boolean; savedAt: string };
  assert.equal(parsed.choice, "acknowledged");
  assert.equal(parsed.necessary, true);
  assert.equal(parsed.optional, false);
  assert.ok(!Number.isNaN(Date.parse(parsed.savedAt)), "savedAt should be an ISO timestamp");
});

test("storage notice on: decline persists the necessary-only choice", async () => {
  const outcome = await runConsentScript({ storageNotice: true });
  const decline = outcome.document.querySelectorAll("[data-cookie-decline]")[0];
  decline.click();
  assert.equal(outcome.writes.length, 1);
  const parsed = JSON.parse(outcome.writes[0][1]) as { choice: string };
  assert.equal(parsed.choice, "necessary");
});

test("storage notice on: a recorded choice means no auto-show", async () => {
  const outcome = await runConsentScript({ storageNotice: true }, "{\"choice\":\"acknowledged\"}");
  assert.equal(bannerOf(outcome).hidden, true, "a saved choice suppresses the auto-show");
  assert.equal(outcome.writes.length, 0);
});

test("storage notice off: banner never shows and nothing is ever stored", async () => {
  const outcome = await runConsentScript({ storageNotice: false });
  const banner = bannerOf(outcome);
  assert.equal(banner.hidden, true, "the notice must never show when the operator switched it off");
  assert.equal(outcome.writes.length, 0, "no preference may be written for the operator's deployment");
  const accept = outcome.document.querySelectorAll("[data-cookie-accept]")[0];
  const decline = outcome.document.querySelectorAll("[data-cookie-decline]")[0];
  accept.click();
  decline.click();
  assert.equal(outcome.writes.length, 0, "accept and decline must not be wired to storage writes");
  assert.equal(banner.hidden, true);
});

test("storage notice off: the cookie-settings control becomes a plain link to the operator's legal page", async () => {
  const outcome = await runConsentScript({ storageNotice: false });
  const control = outcome.document.querySelectorAll("[data-cookie-settings]")[0];
  assert.ok(control.replacedWith, "the button should be replaced by a plain link");
  const link = control.replacedWith;
  assert.equal(link.tag, "a");
  assert.equal(link.href, "/cookie-settings");
  assert.equal(link.className, control.className, "styling should be preserved");
  assert.equal(link.textContent, control.textContent, "the label should be preserved");
  assert.equal(link.getAttribute("aria-label"), "Open Cookie Settings", "the label intent should be preserved");
});

test("config fetch failure falls back to shown (never throws, never hides silently)", async () => {
  const outcome = await runConsentScript({ error: new Error("network down") });
  assert.equal(bannerOf(outcome).hidden, false, "a failed read must keep the notice on");
  assert.equal(outcome.writes.length, 0, "nothing is written before the visitor chooses");
});

test("non-OK config response also falls back to shown", async () => {
  const outcome = await runConsentScript({ httpStatus: 500 });
  assert.equal(bannerOf(outcome).hidden, false);
});

test("the script reads exactly the ui-config endpoint", async () => {
  const outcome = await runConsentScript({ storageNotice: false });
  assert.deepEqual(outcome.requests, ["/api/ui-config"]);
});
