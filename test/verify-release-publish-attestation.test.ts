/**
 * Consumer contract for the canonical scanner and the local fail-closed guard.
 *
 * Supported literal paths retain canonical reports. Supplemental adversarial
 * indirection tests live in publish-indirection.test.ts, including real trackers
 * and behavioral reversion of the guard.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { auditPublishAttestation, report, verify } from "pm-ops/attestation";

import { auditPublishAttestation as launcherAudit, runIfMain, verify as launcherVerify } from "../scripts/verify-release-publish-attestation.ts";

const root = resolve(import.meta.dirname, "..");

test("the gate consumes canonical scanning with a supplemental fail-closed boundary", async () => {
  // Identity, not similarity. A vendored copy that happens to behave the same
  // today is exactly what this fleet spent a session removing, because it stops
  // behaving the same the moment the canonical implementation is fixed again.
  assert.equal(
    existsSync(resolve(root, "scripts/shell-command-scan.ts")),
    false,
    "a local shell-command-scan.ts means the lineage has been re-forked",
  );

  const launcher = await readFile(resolve(root, "scripts/verify-release-publish-attestation.ts"), "utf-8");
  assert.match(launcher, /from "pm-ops\/attestation"/u, "the gate must import the canonical auditor");
  assert.doesNotMatch(
    launcher,
    /from "\.\/shell-command-scan/u,
    "the gate must not resolve any part of its shell model locally",
  );

  // The boundary must be distinct so it can reject unsupported indirection.
  assert.equal(typeof launcherVerify, "function");
  assert.equal(typeof launcherAudit, "function");
  assert.equal(typeof report, "function");
  assert.notEqual(launcherVerify, verify, "verification must apply the supplemental guard");
  assert.notEqual(launcherAudit, auditPublishAttestation, "auditing must apply the supplemental guard");
});

test("the resolved gate still refuses an unattested publish", () => {
  // A behavioural check through the real resolved module, so "it imports the
  // package" cannot pass while the package fails to load or changes shape.
  const workflow = (publish: string): string =>
    ["jobs:", "  release:", "    steps:", "      - run: |", `          ${publish}`].join("\n");

  const unattested = auditPublishAttestation([
    { file: ".github/workflows/release.yml", text: workflow("npm publish --access public") },
  ]);
  assert.equal(unattested.failures.length, 1);

  const attested = auditPublishAttestation([
    { file: ".github/workflows/release.yml", text: workflow("npm publish --access public --provenance") },
  ]);
  assert.deepEqual(attested.failures, []);
  assert.deepEqual(attested.recognition, { kind: "recognized", count: 1 });
});

/**
 * Shell constructions that hand `npm publish` an unreadable `--provenance`
 * binding, each of which a fail-open auditor accepts as attested.
 *
 * These seven were admitted by the canonical auditor at pm-ops 2026.9.7 — the
 * version this repository's lockfile installed until 2026.9.9 — and are refused
 * from 2026.9.9 on. They are reproduced here, at consumer level, because a
 * dependency bump is not a guard: nothing in this repository failed while it was
 * installing an auditor that accepted all seven, and nothing would fail again if
 * a later lockfile change put one back. The property asserted is behavioural —
 * *this* construction is refused by whichever auditor is installed — not a
 * version comparison, which would still pass against a regressed release
 * numbered above any floor.
 */
const FAIL_OPEN_CONSTRUCTIONS: ReadonlyArray<{ id: string; script: string }> = [
  { id: "nonliteral-overwrite", script: "FLAG=--provenance\nFLAG=$OTHER\nnpm publish $FLAG --access public\n" },
  { id: "nonliteral-overwrite-cmdsub", script: "FLAG=--provenance\nFLAG=$(cat /tmp/x)\nnpm publish $FLAG --access public\n" },
  { id: "quoted-metachar-value", script: "FLAG=\"--provenance;\"\nnpm publish $FLAG --access public\n" },
  { id: "single-quoted-metachar-value", script: "FLAG='--provenance;'\nnpm publish $FLAG --access public\n" },
  { id: "multiword-unreadable-tail", script: "FLAG=--provenance\nNOOP=x FLAG=$(true)\nnpm publish $FLAG --access public\n" },
  { id: "quoted-paren-in-substitution", script: "FLAG=--provenance\nFLAG=$(printf ') ' )\nnpm publish $FLAG --access public\n" },
  { id: "unterminated-substitution", script: "FLAG=--provenance\nFLAG=$(unterminated\nnpm publish $FLAG --access public\n" },
];

test("the installed auditor refuses every known fail-open provenance handoff", () => {
  for (const { id, script } of FAIL_OPEN_CONSTRUCTIONS) {
    const audited = auditPublishAttestation([
      { file: `.github/case-${id}.sh`, text: `#!/usr/bin/env bash\n${script}` },
    ]);
    assert.ok(
      audited.failures.length > 0,
      `the installed pm-ops auditor accepted the ${id} construction as attested; `
      + "an unattested publish would reach the registry",
    );
  }
});

test("the fail-open guard still admits a genuinely attested publish", () => {
  // Without this control the guard above passes against an auditor that refuses
  // everything, which would be just as broken and far easier to ship.
  const audited = auditPublishAttestation([
    {
      file: ".github/case-control.sh",
      text: "#!/usr/bin/env bash\nFLAG=--provenance\nnpm publish $FLAG --access public\n",
    },
  ]);
  assert.deepEqual(audited.failures, [], "a readable --provenance binding must still pass");
});

test("this repository's own workflows pass the gate", () => {
  // The guarded verifier pointed at this checkout, which is what CI runs.
  // Reported through
  // captured streams rather than the process ones so a failure is readable.
  const lines: string[] = [];
  let exitCode = 0;
  report(launcherVerify(root), (line) => lines.push(line), (code) => { exitCode = code; });
  assert.equal(exitCode, 0, `the gate must pass on this repository:\n${lines.join("\n")}`);
  assert.ok(lines.some((line) => line.includes("every publish invocation is attested")));
});

test("the launcher runs only as the process entry point", () => {
  // A bare `if` at module scope leaves its own body unreachable from any
  // in-process test, which is how an entry point quietly stops running.
  // A real path that is not this module: isMainInvocation resolves the argv
  // entry, so a nonexistent one throws rather than answering the question.
  assert.equal(runIfMain(["node", resolve(root, "package.json")], import.meta.url, root), false);
  // An argv with no entry at all: node was given no script, so there is no path
  // to compare and nothing can be the entry point. Reached in practice when the
  // module is imported by a runner that rewrites argv, and it must answer false
  // rather than resolve `undefined` as a path.
  assert.equal(runIfMain(["node"], import.meta.url, root), false);
  // An argv[1] that resolves to nothing must THROW, not answer false. If path
  // resolution were changed to swallow the error, a broken direct invocation
  // would exit 0 without ever running the release gate - a silent skip of the
  // whole thing, which is worse than a loud failure.
  assert.throws(
    () => runIfMain(["node", resolve(root, "no", "such", "entry.ts")], import.meta.url, root),
    /ENOENT/u,
    "an unresolvable entry must fail loudly rather than quietly skip the gate",
  );
});

/**
 * A throwaway git repository containing one file, for the gate to discover.
 *
 * Staged rather than committed: the gate finds files through `git ls-files`,
 * which reads the index, so a commit would add nothing except a dependency on
 * ambient git identity configuration.
 *
 * @param prefix - Temp directory name prefix, for readable failures.
 * @param file - Repository-relative path to write.
 * @param contents - What to write there.
 * @param use - Receives the repository root; the tree is removed afterwards.
 * @returns Whatever `use` returned.
 */
function withTrackedFixture<T>(prefix: string, file: string, contents: string, use: (root: string) => T): T {
  const fixture = mkdtempSync(resolve(tmpdir(), prefix));
  try {
    mkdirSync(resolve(fixture, dirname(file)), { recursive: true });
    writeFileSync(resolve(fixture, file), contents);
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: fixture });
    execFileSync("git", ["add", file], { cwd: fixture });
    return use(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

/**
 * Structurally different publishes, so output equality means the executed path
 * agrees with the package across the SHAPE SPACE rather than on one string.
 *
 * A single fixture can be satisfied by a local verifier that hardcodes that one
 * report. This set cannot be: it spans several distinct auditor decisions -
 * whether a publish is recognised at all, whether an unresolved program is
 * audited, whether a foreign publisher counts, whether the subcommand must
 * follow the program, which files are discovered, and whether an attested
 * publish is left alone - and each discovery path carries BOTH verdicts, so a
 * blanket refusal is caught as well as a blanket acceptance.
 *
 * What this establishes, stated narrowly because a wider claim here was wrong
 * twice: the launcher and the package agree across the SELECTED shape space.
 * It is not coverage of every auditor decision, and deliberately not - YAML
 * normalisation, scalar scope across conditional arms, heredocs, wrapper-option
 * parsing and the executable-path variants are the auditor's own behaviour,
 * tested with the implementation in pm-ops where one fix reaches every consumer.
 * Re-testing them here is the duplication this suite exists to remove.
 */
interface PublishShape {
  /** Readable name, used in every assertion message for this shape. */
  name: string;
  /** The publish line(s) to place in the fixture's workflow. */
  publish: string;
  /** Whether the auditor must report a failure for this shape. */
  failing: boolean;
  /** Repository-relative fixture path, when it is not the default workflow. */
  file?: string;
  /** Literal file contents, when the shape is not a workflow. */
  raw?: string;
  /** Set when the failure names no file, as the no-publish case does. */
  unnamed?: boolean;
}

const ENTRY_PATH_FIXTURES: readonly PublishShape[] = [
  { name: "a plain unattested publish", publish: "npm publish --access public", failing: true },
  // The subcommand need not be adjacent to `npm`: an option may precede it, and
  // a diverted implementation matching only the literal pair `npm publish` would
  // agree with the auditor on every other shape here.
  { name: "an unattested publish whose subcommand is not adjacent to npm", publish: "npm --access public publish", failing: true },
  { name: "an attested publish whose subcommand is not adjacent to npm", publish: "npm --access public publish --provenance", failing: false },
  { name: "an unresolved program that cannot be proven not to publish", publish: "$(echo npm) publish", failing: true },
  { name: "a foreign publisher", publish: "pnpm publish --access public", failing: true },
  { name: "an attested publish, which must produce no failure", publish: "npm publish --provenance --access public", failing: false },
  { name: "a runner-prefixed publish", publish: "npx npm publish --access public", failing: true },
  {
    name: "an attested publish that must not mask a second unattested one",
    publish: "npm publish --provenance --access public\n          npm publish --access public",
    failing: true,
  },
  { name: "a publish that disables provenance explicitly", publish: "npm publish --provenance=false --access public", failing: true },
  {
    name: "an unattested publish inside a shell function, the production wrapper shape",
    publish: "publish_release() {\n            npm publish --access public\n          }\n          publish_release",
    failing: true,
  },
  {
    name: "an attested publish inside a shell function",
    publish: "publish_with_provenance() {\n            npm publish --provenance --access public\n          }\n          publish_with_provenance",
    failing: false,
  },
  {
    name: "a repository with no publish at all, which must fail closed",
    publish: "echo nothing to do",
    failing: true,
    unnamed: true,
  },
];

test("the entry path applies the exported verifier for every publish shape", () => {
  // Exercise the entry point against the exported guarded verifier. This binds
  // its process output and exit code to the same behavior callers import.
  const launcherPath = resolve(root, "scripts/verify-release-publish-attestation.ts");
  const launcherUrl = pathToFileURL(launcherPath).href;

  const capture = (run: () => void): string => {
    const written: string[] = [];
    // The raw function, not a bound copy: it is only ever reinstalled, never
    // called, so binding would replace the global method with a fresh wrapper on
    // every capture and stack a layer per fixture iteration.
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      run();
    } finally {
      process.stdout.write = original;
    }
    return written.join("");
  };

  // Every shape above reaches the gate the same way: it is a workflow. The
  // auditor has two further discovery paths, and an implementation that scanned
  // only workflows would agree on all of them and diverge on these - a tracked
  // script outside .github, reached through the shebang branch of
  // isExecutableSource, and a publish declared in a package.json script,
  // reached through manifestCommandLines.
  //
  // Each new path carries BOTH verdicts. An implementation that simply refused
  // every manifest publish would satisfy a failing manifest case on its own,
  // while disagreeing with the auditor about a correctly attested one.
  const SHAPES: readonly PublishShape[] = [
    ...ENTRY_PATH_FIXTURES,
    {
      name: "an unattested publish in a tracked script outside .github",
      publish: "",
      failing: true,
      file: "scripts/release.sh",
      raw: "#!/bin/bash\nnpm publish --access public\n",
    },
    {
      name: "an attested publish in a tracked script outside .github",
      publish: "",
      failing: false,
      file: "scripts/release.sh",
      raw: "#!/bin/bash\nnpm publish --provenance --access public\n",
    },
    {
      name: "an unattested publish in a package.json script",
      publish: "",
      failing: true,
      file: "package.json",
      raw: "{\n  \"name\": \"attestation-fixture\",\n  \"version\": \"1.0.0\",\n  \"scripts\": {\n    \"release\": \"npm publish --access public\"\n  }\n}\n",
    },
    {
      name: "an attested publish in a package.json script",
      publish: "",
      failing: false,
      file: "package.json",
      raw: "{\n  \"name\": \"attestation-fixture\",\n  \"version\": \"1.0.0\",\n  \"scripts\": {\n    \"release\": \"npm publish --provenance --access public\"\n  }\n}\n",
    },
  ];

  for (const shape of SHAPES) {
    // Staged is enough: the gate discovers files through `git ls-files`, which
    // reads the index. Committing would also make the fixture depend on ambient
    // git identity configuration for no gain.
    withTrackedFixture(
      "pm-web-attestation-fixture-",
      shape.file ?? ".github/workflows/release.yml",
      shape.raw ?? ["jobs:", "  release:", "    steps:", "      - run: |", `          ${shape.publish}`].join("\n") + "\n",
      (fixture) => {
      const savedExitCode = process.exitCode;
      try {
        let ran = false;
        const launcherOutput = capture(() => {
          ran = runIfMain(["node", launcherPath], launcherUrl, fixture);
        });
        assert.equal(ran, true, `${shape.name}: the launcher must run the gate when it is the entry point`);
        assert.equal(
          process.exitCode,
          shape.failing ? 1 : savedExitCode,
          `${shape.name}: the exit code must follow the verdict`,
        );

        process.exitCode = savedExitCode;
        const packageOutput = capture(() => {
          report(launcherVerify(fixture), (line) => process.stdout.write(`${line}\n`), (code) => { process.exitCode = code; });
        });
        assert.equal(
          launcherOutput,
          packageOutput,
          `${shape.name}: the entry path must produce the guarded verifier report`,
        );
        if (shape.failing && shape.unnamed !== true) {
          // Name the file. `report` sets exit code 1 for ANY failure, so
          // asserting only that one occurred would let an unrelated failure - a
          // fixture that tracked nothing, say - stand in for the publish this
          // case exists to catch, and the byte comparison would still hold
          // because both sides made the same mistake.
          assert.match(
            launcherOutput,
            new RegExp(`FAIL - ${(shape.file ?? ".github/workflows/release.yml").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"),
            `${shape.name}: the failure must name the fixture's own workflow`,
          );
        } else if (!shape.failing) {
          assert.doesNotMatch(launcherOutput, /FAIL - /u, `${shape.name}: an attested publish must produce no failure`);
        }
      } finally {
        process.exitCode = savedExitCode;
      }
      },
    );
  }
});

/**
 * Reproduce the shebang rule this file's own docstring relies on.
 *
 * The launcher deliberately carries no shebang, and the reason is a concrete
 * claim about the auditor: a shebang naming a SHELL interpreter makes the
 * file's body shell, at which point this file's prose - which necessarily names
 * the command it is guarding - reads as an unattested publish. The claim is
 * reproduced here rather than asserted, because an earlier wording of it said
 * ANY shebang had that effect, and that is not what the auditor does: a shebang
 * says a file executes, not that it executes as shell.
 */
test("only a shebang naming a shell interpreter pulls this file into the scan", () => {
  const body = readFileSync(resolve(root, "scripts/verify-release-publish-attestation.ts"), "utf8");
  // The whole test turns on this file's prose naming the command it guards: that
  // is what the auditor reads as an unattested publish once the body is treated
  // as shell. If the prose stopped mentioning it, every case below would report
  // "not shell input" and the test would pass for the wrong reason.
  assert.match(body, /npm publish/u, "this file must mention the command it guards for the scan to have anything to find");
  const scannedAsShell = (shebang: string): boolean =>
    withTrackedFixture("shebang-", "scripts/verify-release-publish-attestation.ts", shebang + body, (dir) =>
      // The file is reported by name only when the auditor read its body as
      // shell; otherwise the only failure is that the throwaway repository
      // contains no publish at all.
      verify(dir).failures.some((failure) => failure.includes("scripts/verify-release-publish-attestation.ts")));
  assert.equal(scannedAsShell("#!/bin/bash\n"), true, "a bash shebang makes this file shell input");
  assert.equal(scannedAsShell("#!/usr/bin/env sh\n"), true, "an env sh shebang makes this file shell input");
  assert.equal(scannedAsShell("#!/bin/sh\n"), true, "a plain sh shebang makes this file shell input");
  assert.equal(scannedAsShell("#!/usr/bin/env node\n"), false, "a node shebang does not make this file shell input");
  assert.equal(scannedAsShell("#!/usr/bin/env python3\n"), false, "a non-shell interpreter does not make this file shell input");
  assert.equal(scannedAsShell(""), false, "with no shebang the file is not shell input, which is why it has none");
});
