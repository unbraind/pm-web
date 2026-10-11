/**
 * Coverage gate for the package test suite.
 *
 * Runs `node --test` under c8 with the runtime's built-in V8 coverage against the
 * TypeScript sources directly (Node executes `.ts` natively, so the reported
 * line numbers are the ones an author edits, not compiled output), enforces a
 * per-dimension threshold, and reconciles the reported file list against the
 * files actually on disk.
 *
 * That last step is the reason this script exists rather than a bare
 * `node --test --test-coverage-lines=...` invocation. Node only reports files
 * that were loaded during the run: a source module with no test at all is
 * omitted from the report entirely rather than reported at zero. c8's `--all`
 * includes unloaded modules at zero, so they contribute to the denominator.
 * Comparing the resulting report against a directory walk independently checks
 * that every required file was included before publishing accepted receipts.
 *
 * Configuration lives in `package.json` under `coverageGate` so the numbers the
 * gate enforces are visible in the same file that declares the scripts, and a
 * threshold change shows up in review as a deliberate diff.
 *
 * @example
 * ```bash
 * node scripts/coverage-gate.ts
 * ```
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Minimum aggregate percentages measured by c8's Istanbul reporters. */
interface CoverageThresholds {
  /** Minimum percentage of statements that must be executed. */
  readonly statements: number;
  /** Minimum percentage of executable lines that must be covered. */
  readonly lines: number;
  /** Minimum percentage of branch arms that must be taken. */
  readonly branches: number;
  /** Minimum percentage of declared functions that must be invoked. */
  readonly functions: number;
}

/** The `coverageGate` block read from `package.json`. */
interface CoverageGateConfig {
  /**
   * Source locations the gate requires to appear in the report. Each entry is
   * either a directory, walked recursively for `.ts` files, or a single file.
   *
   * Prefer a directory — including `"."` for a package whose entrypoint sits at
   * the repository root. A directory is enumerated at run time, so a source file
   * added later is required automatically. An explicit file list freezes the
   * required set at the moment it was written, and a new untested module simply
   * never enters it, which is the same blind spot this gate exists to close.
   */
  readonly sources: readonly string[];
  /**
   * Directory names skipped while walking, on top of {@link DEFAULT_SKIP_DIRS}.
   * Needed only for a source tree with a non-standard non-source directory.
   */
  readonly skipDirs?: readonly string[];
  /** Test file arguments handed to `node --test`. */
  readonly tests: readonly string[];
  /** Threshold enforced on the aggregate report. */
  readonly thresholds: CoverageThresholds;
  /**
   * Source files exempt from the presence check, each of which must be
   * type-only. A module that erases to nothing emits no coverage counters, so
   * requiring it in the report would make the gate unsatisfiable.
   */
  readonly ignore?: readonly string[];
}

/** Shape of the `package.json` fields this script reads. */
interface PackageManifest {
  readonly coverageGate?: CoverageGateConfig;
}

const repoRoot = resolve(import.meta.dirname, "..");
const coverageDir = join(repoRoot, "coverage");
mkdirSync(coverageDir, { recursive: true });
const reportNames = ["lcov.info", "coverage-summary.json", "coverage-final.json"] as const;
// Invalidate accepted evidence before configuration reads or source inventory can fail.
for (const name of reportNames) rmSync(join(coverageDir, name), { force: true });
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as PackageManifest;
const config = manifest.coverageGate;

if (!config) {
  console.error("coverage-gate: package.json has no `coverageGate` block.");
  process.exit(1);
}

/** Compiler paths used to locate a source file's emitted output. */
interface TsConfig {
  readonly compilerOptions?: { readonly outDir?: string; readonly rootDir?: string };
}

/**
 * Resolves the compiler's effective output paths.
 *
 * Asks `tsc --showConfig` rather than parsing `tsconfig.json` directly: the file
 * may be JSONC and may inherit `outDir`/`rootDir` through an `extends` chain, so
 * a raw `JSON.parse` can either throw on a valid config or silently read the
 * wrong paths.
 *
 * Fails closed if the compiler cannot be reached. This feeds the check that
 * decides whether an exempted module is genuinely type-only, and guessing the
 * emit layout there could clear an executable module by looking at the wrong
 * file — the one outcome this gate must never produce. A package that cannot
 * run its own compiler has a problem worth stopping for.
 */
function resolveEmitPaths(): { outDir: string; rootDir: string } {
  const shown = spawnSync("npx", ["tsc", "--showConfig", "-p", "tsconfig.json"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (shown.status !== 0 || !shown.stdout) {
    console.error(
      [
        "coverage-gate: could not resolve the effective tsconfig via `tsc --showConfig`,",
        "so the emit layout is unknown and `coverageGate.ignore` entries cannot be verified",
        "as type-only. Refusing to guess.",
        shown.stderr?.trim() ? `\n${shown.stderr.trim()}` : "",
      ].join("\n"),
    );
    process.exit(1);
  }
  const parsed = JSON.parse(shown.stdout) as TsConfig;
  return {
    outDir: parsed.compilerOptions?.outDir ?? "dist",
    rootDir: parsed.compilerOptions?.rootDir ?? ".",
  };
}

/**
 * Directories never treated as source, so that `sources: ["."]` works for a
 * package whose entrypoint sits at the repository root.
 *
 * These hold tests, build output, tooling, browser assets and dependencies.
 * Tooling and browser source need their own explicit `sources` entries when
 * included in a package's gate; this default walk does not measure them.
 * A test file cannot appear in its own coverage report.
 */
const DEFAULT_SKIP_DIRS: readonly string[] = [
  "node_modules",
  "dist",
  "dist-test",
  "coverage",
  "test",
  "tests",
  "scripts",
  "public",
  ".agents",
  ".git",
  ".github",
];

const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(config.skipDirs ?? [])]);

/**
 * Collects every TypeScript source file at a configured location.
 *
 * A file entry resolves to itself; a directory entry is walked recursively with
 * {@link DEFAULT_SKIP_DIRS} pruned. Declaration files are skipped either way:
 * they carry no runtime code and so can never appear in a coverage report.
 *
 * @param target - Absolute path to a source file or directory.
 * @returns Repository-relative POSIX paths, in directory order.
 */
function collectSources(target: string): string[] {
  if (!existsSync(target)) {
    console.error(
      `coverage-gate: \`coverageGate.sources\` names ${relative(repoRoot, target)}, which does not exist.`,
    );
    process.exit(1);
  }
  if (!statSync(target).isDirectory()) {
    if (!target.endsWith(".ts") || target.endsWith(".d.ts")) {
      console.error(
        `coverage-gate: \`coverageGate.sources\` names ${relative(repoRoot, target)}, which is not a TypeScript source file. A declaration file or non-TypeScript entry can never appear in a coverage report, so requiring it would make the gate unsatisfiable.`,
      );
      process.exit(1);
    }
    return [relative(repoRoot, target).split(sep).join("/")];
  }
  const found: string[] = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        found.push(...collectSources(join(target, entry.name)));
      }
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(relative(repoRoot, join(target, entry.name)).split(sep).join("/"));
    }
  }
  return found;
}

const expected = [...new Set(config.sources.flatMap((source) => collectSources(join(repoRoot, source))))].sort();
const exempt = new Set(config.ignore ?? []);
const required = expected.filter((file) => !exempt.has(file));

/**
 * Rejects an `ignore` entry that still carries runtime code.
 *
 * The exemption exists for type-only modules, which erase to nothing and so can
 * never appear in a coverage report. Left untested, it is also the one way to
 * remove an executable module from both the measured set and the required set —
 * exactly the escape this gate exists to prevent. TypeScript emits `export {};`
 * and nothing else for a module that erases completely, so the compiled output
 * settles the question rather than the author's say-so.
 */
const emitPaths = (config.ignore ?? []).length > 0 ? resolveEmitPaths() : { outDir: "dist", rootDir: "." };

for (const file of config.ignore ?? []) {
  if (!expected.includes(file)) {
    console.error(`coverage-gate: \`coverageGate.ignore\` names ${file}, which is not under \`sources\`.`);
    process.exit(1);
  }
  const emitted = join(
    repoRoot,
    emitPaths.outDir,
    relative(join(repoRoot, emitPaths.rootDir), join(repoRoot, file)),
  ).replace(/\.ts$/, ".js");
  if (!existsSync(emitted)) {
    console.error(
      `coverage-gate: cannot verify that ignored file ${file} is type-only — no compiled output at ${relative(repoRoot, emitted)}. Build before running the gate, or correct \`outDir\`/\`rootDir\`.`,
    );
    process.exit(1);
  }
  // Block comments are stripped as well as line comments: tsc carries a
  // file-leading JSDoc into the emit, so a documented type-only module would
  // otherwise read as runtime code and be rejected for having a comment.
  const body = readFileSync(emitted, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/export\s*\{\s*\}\s*;?/g, "")
    .trim();
  if (body.length > 0) {
    console.error(
      `coverage-gate: \`coverageGate.ignore\` names ${file}, but it emits runtime code to ${relative(repoRoot, emitted)}. Only type-only modules may be exempt; anything executable must be covered.`,
    );
    process.exit(1);
  }
}

if (required.length === 0) {
  console.error("coverage-gate: source walk found no files; check `coverageGate.sources`.");
  process.exit(1);
}

for (const metric of ["statements", "lines", "branches", "functions"] as const) {
  const threshold = config.thresholds[metric];
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    console.error(`coverage-gate: thresholds.${metric} must be a number from 0 to 100.`);
    process.exit(1);
  }
}

// Each measurement owns its reports and counters, including spawned CLI processes.
// c8's --all records unexecuted files at zero rather than dropping the denominator.
const runDir = mkdtempSync(join(coverageDir, ".run-"));
const measuredLcov = join(runDir, "lcov.info");
const runnerEnv: NodeJS.ProcessEnv = { ...process.env, TZ: "UTC" };
delete runnerEnv.NODE_V8_COVERAGE;
const result = spawnSync(
  process.execPath,
  [
    join(repoRoot, "node_modules", "c8", "bin", "c8.js"),
    "--config=package.json",
    "--all",
    `--src=${repoRoot}`,
    "--extension=.ts",
    ...required.map((file) => `--include=${file}`),
    "--reporter=text",
    "--reporter=json-summary",
    "--reporter=json",
    "--reporter=lcovonly",
    `--reports-dir=${runDir}`,
    `--temp-directory=${join(runDir, "v8")}`,
    "--check-coverage",
    `--statements=${config.thresholds.statements}`,
    `--lines=${config.thresholds.lines}`,
    `--branches=${config.thresholds.branches}`,
    `--functions=${config.thresholds.functions}`,
    process.execPath,
    "--test",
    // Each file can spawn real SDK/CLI and database work. Run files serially so
    // the graph budget measures its operation rather than this suite's fanout.
    "--test-concurrency=1",
    "--test-reporter=spec",
    ...config.tests,
  ],
  { cwd: repoRoot, stdio: "inherit", env: runnerEnv },
);

if (result.error || result.status !== 0) {
  if (result.error) console.error(`coverage-gate: failed to start the test runner: ${result.error.message}`);
  rmSync(runDir, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

const lcovPath = measuredLcov;
/**
 * Source files the run actually reported on, read back from the lcov output.
 *
 * `SF:` paths are normalised to repository-relative POSIX form so they can be
 * compared against the walk. The lcov reporter emits them relative to the
 * working directory on Linux, but that is not contractual and Windows runners
 * have been seen to emit absolute paths; without normalising, the presence
 * check would invert into a permanently red build that blames every source file
 * for never loading.
 */
const reported = new Set<string>();
try {
  statSync(lcovPath);
  for (const line of readFileSync(lcovPath, "utf8").split("\n")) {
    if (!line.startsWith("SF:")) continue;
    const raw = line.slice(3).trim();
    const abs = isAbsolute(raw) ? raw : join(repoRoot, raw);
    reported.add(relative(repoRoot, abs).split(sep).join("/"));
  }
} catch {
  console.error(`coverage-gate: no coverage report was written to ${relative(repoRoot, lcovPath)}.`);
  rmSync(runDir, { recursive: true, force: true });
  process.exit(1);
}

const missing = required.filter((file) => !reported.has(file));

if (missing.length > 0) {
  console.error(
    [
      "",
      `coverage-gate: ${missing.length} required source file(s) were omitted from the coverage report:`,
      ...missing.map((file) => `  - ${file}`),
      "",
      "Check reporter inclusion and exercise each executable file through real tests.",
      "A file that is genuinely type-only belongs in `coverageGate.ignore` in package.json.",
      "",
    ].join("\n"),
  );
  rmSync(runDir, { recursive: true, force: true });
  process.exit(1);
}

for (const name of reportNames) copyFileSync(join(runDir, name), join(coverageDir, name));
rmSync(runDir, { recursive: true, force: true });

console.log(`\ncoverage-gate: ${required.length} source file(s) reported, thresholds met.`);
