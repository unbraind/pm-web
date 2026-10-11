import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("workflow-only pin updates pass the real policy while unsafe or inconsistent workflows fail", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pm-web-workflow-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "test"));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "junction");
  writeFileSync(join(root, "test/workflow-security.test.ts"), readFileSync(new URL("./workflow-security.test.ts", import.meta.url)));
  writeFileSync(join(root, ".github/dependabot.yml"), readFileSync(new URL("../.github/dependabot.yml", import.meta.url)));
  const workflows = new Map(readdirSync(new URL("../.github/workflows", import.meta.url))
    .filter((file) => /\.ya?ml$/.test(file)).map((file) =>
    [file, readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8")]));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const original = workflows.get("ci.yml")!;
  const actionLine = /^\s*uses: actions\/setup-node@[^\n]+/m;
  assert.match(original, actionLine);
  const newPin = "a".repeat(40);

  /** Run the actual repository gate against only changed workflow bytes. */
  function runScenario(ci: string, codeql = workflows.get("codeql.yml")!): SpawnSyncReturns<string> {
    for (const [file, bytes] of workflows) writeFileSync(join(root, ".github/workflows", file), bytes);
    writeFileSync(join(root, ".github/workflows/ci.yml"), ci);
    writeFileSync(join(root, ".github/workflows/codeql.yml"), codeql);
    return spawnSync(process.execPath, ["--test", "test/workflow-security.test.ts"], { cwd: root, encoding: "utf8", env });
  }

  for (const reference of [
    `uses: actions/setup-node@${newPin} # v7.1.0`,
    `uses: "actions/setup-node@${newPin}" # v7.1.0`,
    `"uses": 'actions/setup-node@${newPin}' # v7.1.0`,
  ]) {
    const result = runScenario(original.replace(actionLine, `        ${reference}`));
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }

  const compact = original + `\n      - uses: actions/setup-node@v7 # v7\n`;
  const unsafe = runScenario(compact);
  assert.equal(unsafe.status, 1, unsafe.stdout + unsafe.stderr);
  assert.match(unsafe.stdout, /must pin a full 40-character commit SHA/);

  const codeql = workflows.get("codeql.yml")!;
  const quotedCodeql = codeql
    .replace(/(uses: )(github\/codeql-action\/init@[0-9a-f]{40})/, '$1"$2"')
    .replace(/(uses: )(github\/codeql-action\/analyze@[0-9a-f]{40})/, "$1'$2'");
  const quoted = runScenario(original, quotedCodeql);
  assert.equal(quoted.status, 0, quoted.stdout + quoted.stderr);
  const commentedCodeql = codeql.replace(/uses: (github\/codeql-action\/[^\n]+)/g, "# uses: $1");
  const commented = runScenario(original, commentedCodeql);
  assert.equal(commented.status, 1, commented.stdout + commented.stderr);
  assert.match(commented.stdout, /must keep every sub-action under this gate/);

  const inconsistentCommit = codeql.replace(/(github\/codeql-action\/analyze@)[0-9a-f]{40}/, `$1${newPin}`);
  assert.equal(runScenario(original, inconsistentCommit).status, 1, "CodeQL commits must agree");
  const inconsistentVersion = codeql.replace(/(github\/codeql-action\/analyze@[^\n]+# )v[^\n]+/, "$1v99.0.0");
  assert.equal(runScenario(original, inconsistentVersion).status, 1, "CodeQL release comments must agree");

  writeFileSync(join(root, ".github/workflows/new-supplier.yaml"), `steps:\n  - uses: untrusted/action@${newPin} # v1\n`);
  const extraWorkflow = runScenario(original);
  assert.equal(extraWorkflow.status, 1, extraWorkflow.stdout + extraWorkflow.stderr);
  assert.match(extraWorkflow.stdout, /action owner is not allowed: untrusted\/action/);

});
