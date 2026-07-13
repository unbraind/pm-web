import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";

// Package root (test/ is compiled to dist-test/, so go up one level from there).
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(packageRoot, "public");

const swSourcePath = path.join(publicDir, "src", "sw.ts");
const cookieSourcePath = path.join(publicDir, "src", "cookie-consent.ts");
const swOutputPath = path.join(publicDir, "sw.js");
const cookieOutputPath = path.join(publicDir, "cookie-consent.js");

// Build the two static scripts from their TypeScript sources before any
// assertion runs. This keeps the test self-contained (it does not depend on a
// prior `npm run build`) and validates the real build pipeline produces the
// deterministic outputs served at the same public URLs.
function buildScripts(): void {
  const tscBin = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
  for (const project of ["tsconfig.sw.json", "tsconfig.scripts.json"]) {
    execFileSync(process.execPath, [tscBin, "-p", `public/${project}`], {
      cwd: packageRoot,
      // Forward tsc stdout/stderr diagnostics to the CI log (inherit) while
      // keeping stdin ignored so the build stays noninteractive (no prompts).
      stdio: ["ignore", "inherit", "inherit"],
    });
  }
}

before(() => {
  buildScripts();
});

/** Assert that a generated script is valid JavaScript (parses with no TS). */
function assertValidJs(file: string, label: string): string {
  const src = readFileSync(file, "utf8");
  // `new Function` parses the body without executing it; TypeScript type
  // annotations (e.g. `const x: Promise<X>`) are SyntaxErrors in plain JS, so a
  // successful construction proves the emitted output is annotation-free.
  // eslint-disable-next-line no-new-func
  new Function(src);
  assert.ok(src.trim().length > 0, `${label} should be non-empty`);
  return src;
}

/** Recursively list .ts files under a directory. */
function listTs(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTs(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Run `git check-ignore` and return the matched paths (empty when none are ignored, exit 1). */
function gitCheckIgnore(paths: string[]): string[] {
  try {
    const out = execFileSync("git", ["check-ignore", ...paths], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    return out.trim().split("\n").filter(Boolean);
  } catch (err) {
    // exit code 1 means none of the paths are ignored — the expected "not ignored" case.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

/** Remove block and line comments so interface/cast checks are not fooled by prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("TypeScript sources are the tracked source of truth and generated outputs are build artifacts", () => {
  assert.ok(existsSync(swSourcePath), "public/src/sw.ts should exist");
  assert.ok(existsSync(cookieSourcePath), "public/src/cookie-consent.ts should exist");
  // The TypeScript sources must be trackable (not gitignored) — they are the
  // canonical sources, unlike the generated JS artifacts.
  assert.deepEqual(
    gitCheckIgnore(["public/src/sw.ts", "public/src/cookie-consent.ts"]),
    [],
    "TypeScript sources must not be gitignored",
  );
  // The generated JS outputs must be ignored build artifacts (not hand-edited).
  assert.deepEqual(
    gitCheckIgnore(["public/sw.js", "public/cookie-consent.js"]).sort(),
    ["public/cookie-consent.js", "public/sw.js"],
    "generated JS outputs must be gitignored build artifacts",
  );
});

test("generated sw.js is valid JavaScript served at /sw.js with no TypeScript annotations", () => {
  const src = assertValidJs(swOutputPath, "sw.js");
  // The generated file must not contain TS-only constructs that `new Function`
  // would have rejected; additionally assert the absence of cast markers that
  // are erased by tsc so a regression to hand-written TS-as-JS is caught.
  assert.ok(!src.includes("as unknown as"), "sw.js must not leak TS casts");
  assert.ok(!/\binterface \w+\s+extends\b/.test(stripComments(src)), "sw.js must not leak TS interfaces");
  // Deterministic placeholder preserved verbatim (no build-time substitution).
  assert.ok(src.includes("'__BUILD_TIME__'"), "sw.js preserves the __BUILD_TIME__ placeholder");
  assert.ok(src.includes("Date.now().toString(36)"), "sw.js preserves the runtime cache-name fallback");
  // Service worker behavior markers.
  assert.ok(src.includes("pm-web-"), "sw.js builds the pm-web cache name");
  assert.ok(src.includes("MUTATIONS_REPLAYED"), "sw.js replays queued mutations");
  assert.ok(src.includes("pm-sync"), "sw.js registers the background sync tag");
  assert.ok(src.includes("You're offline"), "sw.js ships the offline fallback page");
});

test("generated cookie-consent.js is a valid classic script with no import/export", () => {
  const src = assertValidJs(cookieOutputPath, "cookie-consent.js");
  // Loaded via <script src="/cookie-consent.js"> (no type=module), so the
  // emitted output must not contain module syntax.
  assert.ok(!/^\s*(import|export)\b/m.test(src), "cookie-consent.js must be a classic script (no import/export)");
  assert.ok(src.includes("pm_cookie_preferences_v1"), "cookie-consent.js uses the v1 storage key");
  assert.ok(src.includes("data-cookie-accept"), "cookie-consent.js wires the accept button");
  assert.ok(src.includes("data-cookie-decline"), "cookie-consent.js wires the decline button");
  assert.ok(src.includes("data-cookie-settings"), "cookie-consent.js wires the settings links");
  // IIFE keeps the global scope clean (matches the prior hand-written shape).
  assert.ok(/\(\s*\(\s*\)\s*=>/.test(src) || /\(\s*function\s*\(/.test(src), "cookie-consent.js wraps logic in an IIFE");
});

test("the service worker precache list covers every generated frontend chunk", () => {
  const tsSource = readFileSync(swSourcePath, "utf8");
  const arrayMatch = tsSource.match(/STATIC_ASSETS[^=]*=\s*\[([\s\S]*?)\]/);
  assert.ok(arrayMatch, "sw.ts must declare a STATIC_ASSETS array");
  const precache = new Set<string>(arrayMatch[1].match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) ?? []);
  // Map every tracked frontend .ts chunk (excluding sw.ts / cookie-consent.ts,
  // which are not app chunks loaded by index.html) to its served URL.
  const excluded = new Set(["sw.ts", "cookie-consent.ts"]);
  const chunks = listTs(path.join(publicDir, "src"))
    .map((f) => path.relative(publicDir, f))
    .filter((rel) => !excluded.has(path.basename(rel)))
    .map((rel) => "/" + rel.replace(/\.ts$/, ".js").split(path.sep).join("/"));
  for (const chunk of chunks) {
    assert.ok(
      precache.has(chunk),
      `STATIC_ASSETS must precache the generated frontend chunk ${chunk} (missing from service worker install list)`,
    );
  }
});

test("sw.ts source is type-safe: no `any`, ts-ignore, or unsafe response casts", () => {
  const src = readFileSync(swSourcePath, "utf8");
  const stripped = stripComments(src);
  // The ServiceWorkerGlobalScope narrow is the one documented, intentional
  // `as unknown as` cast (the WebWorker lib types `self` as the generic
  // WorkerGlobalScope). Every other `as` narrowing must be explicit and
  // annotation-free of `any`.
  assert.ok(!/\bas\s+any\b/.test(stripped), "sw.ts must not use `as any` casts");
  assert.ok(!/:\s*any\b/.test(stripped), "sw.ts must not use `: any` annotations");
  assert.ok(!/@ts-ignore/.test(src), "sw.ts must not use @ts-ignore");
  assert.ok(!/@ts-expect-error/.test(src), "sw.ts must not use @ts-expect-error");
  // event.respondWith must never receive an unsafe `as Promise<Response>` cast.
  assert.ok(!/as\s+Promise\u003cResponse\u003e/.test(stripped), "sw.ts must not cast to Promise<Response>");
});

test("sw.ts compiles cleanly under the service-worker tsconfig (type-level safety)", () => {
  // A zero-exit `tsc --noEmit` proves the source typechecks against the
  // WebWorker lib with strict mode — the strongest type-level guarantee we
  // can assert without a browser/IndexedDB runtime.
  const tscBin = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tscBin, "-p", "public/tsconfig.sw.json", "--noEmit"], {
    cwd: packageRoot,
    stdio: ["ignore", "inherit", "inherit"],
  });
});

test("emitted sw.js honors the mutation-queue persistence contract", () => {
  const src = readFileSync(swOutputPath, "utf8");
  // A typed transaction-completion helper is emitted and awaited by both the
  // queue and clear paths, so persistence is durable (not fire-and-forget).
  assert.ok(src.includes("function transactionDone("), "sw.js emits the transactionDone helper");
  assert.ok(/await transactionDone\(tx\)/.test(src), "sw.js awaits transaction completion");
  // queueMutation returns an explicit boolean so callers cannot claim a queued
  // mutation when persistence failed.
  assert.ok(/queueMutation\b/.test(src), "sw.js emits queueMutation");
  // Success path: 202 with queued:true.
  assert.ok(src.includes("queued: true"), "sw.js reports queued:true on persistence success");
  assert.ok(/status:\s*202/.test(src), "sw.js responds 202 Accepted when queued");
  // Failure path: explicit 503 with queued:false — never claims success.
  assert.ok(src.includes("queued: false"), "sw.js reports queued:false on persistence failure");
  assert.ok(src.includes("unable to queue mutation"), "sw.js surfaces a 503 when persistence fails");
});

test("emitted sw.js always resolves fetch handlers with a Response (no undefined)", () => {
  const src = readFileSync(swOutputPath, "utf8");
  // Every fetch branch must terminate with an explicit 503 fallback instead of
  // resolving event.respondWith with `undefined` (which throws at runtime).
  // Static-asset + default paths share the "Unavailable offline" 503 body.
  const offline503 = src.match(/Unavailable offline/g) ?? [];
  assert.ok(offline503.length >= 2, "sw.js ships an explicit 503 fallback for static + default paths");
  // No unsafe `as Promise<Response>` cast survives in emitted JS.
  assert.ok(!/as\s+Promise\u003cResponse\u003e/.test(src), "sw.js must not leak unsafe Promise<Response> casts");
  assert.ok(!/\.catch\(\(\) =\u003e cached\)/.test(src), "sw.js must not fall back to an undefined cached value");
});

test("emitted sw.js preserves service-worker behavioral contracts", () => {
  const src = readFileSync(swOutputPath, "utf8");
  // Install/activate/fetch lifecycle markers.
  assert.ok(/addEventListener\(['"]install['"]/.test(src), "sw.js registers an install handler");
  assert.ok(/addEventListener\(['"]activate['"]/.test(src), "sw.js registers an activate handler");
  assert.ok(/addEventListener\(['"]fetch['"]/.test(src), "sw.js registers a fetch handler");
  // Background sync + online flush contracts.
  assert.ok(src.includes("pm-sync"), "sw.js registers the background sync tag");
  assert.ok(src.includes("FLUSH_QUEUE"), "sw.js handles the FLUSH_QUEUE message");
  assert.ok(src.includes("MUTATIONS_REPLAYED"), "sw.js notifies clients of replayed mutations");
  assert.ok(src.includes("MUTATIONS_PARTIAL"), "sw.js notifies clients of partial replay");
  // Offline fallback page contract.
  assert.ok(src.includes("You're offline"), "sw.js ships the offline fallback page");
  // Cache-name + build-placeholder determinism.
  assert.ok(src.includes("pm-web-"), "sw.js builds the pm-web cache name");
  assert.ok(src.includes("'__BUILD_TIME__'"), "sw.js preserves the __BUILD_TIME__ placeholder");
  assert.ok(src.includes("Date.now().toString(36)"), "sw.js preserves the runtime cache-name fallback");
});