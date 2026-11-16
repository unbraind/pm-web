/** Keep browser-importing tests buildable from an ordinary source checkout. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

/** Expand npm script calls in execution order, preserving the frontend build boundary. */
function commands(script: string, ancestors: string[] = []): string[] {
  assert.ok(!ancestors.includes(script), `npm script cycle: ${[...ancestors, script].join(" -> ")}`);
  assert.ok(scripts[script], `missing npm script: ${script}`);
  return scripts[script].split(/\s*&&\s*/).flatMap(command => {
    const nested = /^npm run ([\w:-]+)$/.exec(command);
    if (!nested || nested[1] === "build:frontend") return [command];
    return commands(nested[1], [...ancestors, script]);
  });
}

test("local and CI documentation tests build frontend imports before running tests", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")) as {
    jobs: { test: { steps: Array<{ name?: string; if?: string; run?: string }> } };
  };
  const docs = workflow.jobs.test.steps.find(step => step.name === "Documentation, tracker, privacy and packed documentation contracts");
  assert.ok(docs?.run, "documentation CI step must exist");
  assert.equal(docs.if, "steps.changes.outputs.code != 'true'");
  assert.match(docs.run, /^\s*npm run test:docs\s*$/m);
  assert.doesNotMatch(docs.run, /node\s+--test/, "CI must use the local npm entry point");
  for (const script of ["test", "test:docs"]) {
    const expanded = commands(script);
    const build = expanded.indexOf("npm run build:frontend");
    const tests = expanded.findIndex(command => /\bnode\s+--test\b/.test(command));
    assert.ok(build >= 0 && tests > build, `${script} must build frontend JavaScript before importing tests`);
  }
  assert.match(scripts["build:frontend"], /\btsc\b/, "the shared prerequisite must compile frontend sources");
  assert.match(scripts["test:docs"], /test\/evidence-source-security\.test\.ts\b/);
  assert.match(scripts["test:docs"], /test\/workflow-frontend-prerequisite\.test\.ts\b/);
});
