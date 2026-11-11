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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package root, resolved from this helper (test/helpers/) so tests share one value. */
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The served `public/` directory of the package. */
export const publicDir = path.join(packageRoot, "public");

/** One suite's generated scripts and the cleanup for its private output tree. */
export interface StaticScripts {
  /** This build's classic consent script. */
  readonly cookieConsentOutputPath: string;
  /** This build's service worker. */
  readonly swOutputPath: string;
  /** Remove only this build's generated output directory. */
  cleanup(): void;
}

/**
 * Compile the two static scripts from their TypeScript sources.
 *
 * Runs the repo's own `tsc` against `public/tsconfig.sw.json` and
 * `public/tsconfig.scripts.json`, forwarding compiler diagnostics to the test
 * log while keeping stdin ignored so the build stays noninteractive.
 * Each call owns a temporary output tree; the caller must register cleanup.
 */
export function buildStaticScripts(): StaticScripts {
  const outputDir = mkdtempSync(path.join(tmpdir(), "pm-web-static-scripts-"));
  const cleanup = (): void => { rmSync(outputDir, { recursive: true, force: true }); };
  const tscBin = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
  try {
    for (const project of ["tsconfig.sw.json", "tsconfig.scripts.json"]) {
      execFileSync(process.execPath, [tscBin, "-p", `public/${project}`, "--outDir", outputDir], {
        cwd: packageRoot,
        stdio: ["ignore", "inherit", "inherit"],
      });
    }
    return {
      cookieConsentOutputPath: path.join(outputDir, "cookie-consent.js"),
      swOutputPath: path.join(outputDir, "sw.js"),
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
