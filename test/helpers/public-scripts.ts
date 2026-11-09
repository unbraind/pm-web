/**
 * Shared helpers for tests that build or inspect the public static scripts
 * (`sw.js`, `cookie-consent.js`) and the served public pages.
 *
 * The build step compiles the TypeScript sources before any assertion runs,
 * so a test stays self-contained (it does not depend on a prior
 * `npm run build`) while still executing the real build pipeline and the
 * deterministic artifacts browsers are served.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package root, resolved from this helper (test/helpers/) so tests share one value. */
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The served `public/` directory of the package. */
export const publicDir = path.join(packageRoot, "public");

/** Absolute path of the built classic consent script (`/cookie-consent.js`). */
export const cookieConsentOutputPath = path.join(publicDir, "cookie-consent.js");

/**
 * Compile the two static scripts from their TypeScript sources.
 *
 * Runs the repo's own `tsc` against `public/tsconfig.sw.json` and
 * `public/tsconfig.scripts.json`, forwarding compiler diagnostics to the test
 * log while keeping stdin ignored so the build stays noninteractive.
 */
export function buildStaticScripts(): void {
  const tscBin = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
  for (const project of ["tsconfig.sw.json", "tsconfig.scripts.json"]) {
    execFileSync(process.execPath, [tscBin, "-p", `public/${project}`], {
      cwd: packageRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
  }
}
