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

/** Everything one script execution observed: storage, elements, requests, timers. */
interface ScriptOutcome {
  /** Fake document the script ran against. */
  document: FakeDocument;
  /** Recorded localStorage writes, in order. */
  writes: Array<[string, string]>;
  /** Recorded fetch targets. */
  requests: string[];
  /** Captured `setTimeout` callbacks (the config-read deadline), in order. */
  timers: Array<() => void>;
  /** Pending deadline handles, used to verify cleanup after a fast response. */
  pendingTimers: Set<number>;
  /** Signal passed to the actual fetch call. */
  signals: AbortSignal[];
  /** For the `deferredBody` scenario: settle the pending fetch with a body. */
  settleFetch: ((body: string) => void) | null;
}

/** How the fake `/api/ui-config` fetch behaves in one script run. */
type FetchScenario =
  | { storageNotice: boolean }
  | { error: Error }
  | { httpStatus: number }
  /** The fetch never settles (a proxy that stalls the connection). */
  | { stalled: true }
  /** The headers arrive but the body never settles. */
  | { stalledBody: true }
  /** The fetch settles only when the test calls `settleFetch` with a body. */
  | { deferredBody: true };

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
 * The vm context provides a captured `setTimeout` instead of a real one, so
 * tests decide when the config-read deadline fires and can observe both
 * sides of the race (fast response, stalled response, late response).
 *
 * @param options - How the `/api/ui-config` fetch behaves.
 * @param storedChoice - Value previously present in localStorage, or `null`.
 * @returns The observed fake document, storage writes, requests, timers, and
 *   (for `deferredBody`) the callback that settles the pending fetch.
 */
async function runConsentScript(
  options: FetchScenario,
  storedChoice: string | null = null,
): Promise<ScriptOutcome> {
  const source = builtSource;
  const document = makeDocument();
  const writes: Array<[string, string]> = [];
  const requests: string[] = [];
  const timers: Array<() => void> = [];
  const pendingTimers = new Set<number>();
  const signals: AbortSignal[] = [];
  let settleFetch: ((body: string) => void) | null = null;
  const store = new Map<string, string>();
  if (storedChoice !== null) store.set("pm_cookie_preferences_v1", storedChoice);
  const localStorage = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      writes.push([key, value]);
      store.set(key, value);
    },
  };
  const fetchImpl = (url: string, init?: { signal?: AbortSignal }): Promise<{ ok: boolean; text: () => Promise<string> }> => {
    requests.push(url);
    if (init?.signal) signals.push(init.signal);
    if ("error" in options) return Promise.reject(options.error);
    if ("httpStatus" in options) {
      return Promise.resolve({ ok: false, text: () => Promise.resolve("Not found") });
    }
    if ("stalled" in options) return new Promise(() => { /* never settles */ });
    if ("stalledBody" in options) return Promise.resolve({ ok: true, text: () => new Promise(() => { /* never settles */ }) });
    if ("deferredBody" in options) {
      return new Promise((resolve) => {
        settleFetch = (body: string) => resolve({ ok: true, text: () => Promise.resolve(body) });
      });
    }
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ storageNotice: options.storageNotice })),
    });
  };
  const setTimeoutImpl = (callback: () => void, ms: number): number => {
    assert.ok(ms > 0 && ms <= 3000, "the fallback deadline must be bounded to three seconds");
    timers.push(callback);
    pendingTimers.add(timers.length);
    return timers.length;
  };
  const clearTimeoutImpl = (handle: number): void => { pendingTimers.delete(handle); };
  const context = vm.createContext({ document, localStorage, fetch: fetchImpl, setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl, AbortController });
  new vm.Script(source, { filename: "cookie-consent.js" }).runInContext(context);
  // Flush the config read's promise chain (microtasks + one macrotask tick).
  await new Promise((resolve) => { setImmediate(resolve); });
  return { document, writes, requests, timers, pendingTimers, signals, settleFetch };
}

/** Fire every captured timer callback, then flush the promise chains again. */
async function flushTimers(outcome: ScriptOutcome): Promise<void> {
  for (const handle of [...outcome.pendingTimers]) outcome.timers[handle - 1]();
  await new Promise((resolve) => { setImmediate(resolve); });
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

test("an unparsable config body falls back to shown", async () => {
  const outcome = await runConsentScript({ deferredBody: true });
  assert.ok(outcome.settleFetch, "deferred scenario should expose the settle callback");
  outcome.settleFetch("not-json{");
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(bannerOf(outcome).hidden, false, "a garbage body must keep the notice on");
});

test("a stalled config read falls back to shown after the deadline instead of hanging", async () => {
  const outcome = await runConsentScript({ stalled: true });
  // Before the deadline the decision is still pending: no premature show,
  // but also no permanent hide.
  assert.equal(bannerOf(outcome).hidden, true, "undecided state keeps the banner hidden");
  assert.equal(outcome.timers.length, 1, "the script should arm exactly one deadline timer");
  await flushTimers(outcome);
  assert.equal(bannerOf(outcome).hidden, false, "a stalled read must fall back to shown after the deadline");
  assert.equal(outcome.writes.length, 0);
  assert.equal(outcome.signals[0].aborted, true, "the stalled request should be cancelled");
  const control = outcome.document.querySelectorAll("[data-cookie-settings]")[0];
  bannerOf(outcome).hidden = true;
  control.click();
  assert.equal(bannerOf(outcome).hidden, false, "settings must be wired after fallback");
});

test("a stalled response body also reaches the fallback deadline", async () => {
  const outcome = await runConsentScript({ stalledBody: true });
  assert.equal(bannerOf(outcome).hidden, true);
  await flushTimers(outcome);
  assert.equal(bannerOf(outcome).hidden, false);
  assert.equal(outcome.signals[0].aborted, true);
});

test("a fast off response clears its timer and remains off after the deadline", async () => {
  const outcome = await runConsentScript({ storageNotice: false });
  assert.equal(outcome.pendingTimers.size, 0, "a completed config read must clear its deadline");
  await flushTimers(outcome);
  assert.equal(bannerOf(outcome).hidden, true);
  assert.equal(outcome.writes.length, 0);
});

test("a late off response after the deadline cannot hide the already-shown notice", async () => {
  const outcome = await runConsentScript({ deferredBody: true });
  assert.ok(outcome.settleFetch, "deferred scenario should expose the settle callback");
  // The deadline wins: the notice is shown.
  await flushTimers(outcome);
  assert.equal(bannerOf(outcome).hidden, false);
  // The response finally arrives with storageNotice:false — too late.
  outcome.settleFetch(JSON.stringify({ storageNotice: false }));
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(bannerOf(outcome).hidden, false, "a late response must not flip the decision");
  const control = outcome.document.querySelectorAll("[data-cookie-settings]")[0];
  assert.equal(control.replacedWith, null, "a late response must not rewire the settings control");
  assert.equal(outcome.writes.length, 0);
});

test("the script reads exactly the ui-config endpoint", async () => {
  const outcome = await runConsentScript({ storageNotice: false });
  assert.deepEqual(outcome.requests, ["/api/ui-config"]);
});
