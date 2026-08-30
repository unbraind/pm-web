import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

/** Reviewed action commits allowed in this repository's workflows. */
const TRUSTED_ACTION_COMMITS = new Map<string, string>([
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
  ["oven-sh/setup-bun", "0c5077e51419868618aeaa5fe8019c62421857d6"],
  // The CodeQL action is referenced twice, as distinct sub-actions sharing one
  // release commit, so both names must be listed for the gate to cover them.
  ["github/codeql-action/init", "cdf488f595d80d6e07e03d4674febd5ab45fa938"],
  ["github/codeql-action/analyze", "cdf488f595d80d6e07e03d4674febd5ab45fa938"],
]);

/** Workflow files shipped by this repository. */
const WORKFLOW_FILES = ["ci.yml", "release.yml", "codeql.yml"] as const;

test("every external workflow action is pinned to its reviewed commit", () => {
  for (const file of WORKFLOW_FILES) {
    const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    const uses = [...workflow.matchAll(/^\s*uses:\s*([^@\s]+)@([^\s#]+)/gm)];
    assert.ok(uses.length > 0, `${file} must exercise the action-pin gate`);
    for (const match of uses) {
      const action = match[1]!;
      const revision = match[2]!;
      assert.equal(
        revision,
        TRUSTED_ACTION_COMMITS.get(action),
        `${file}: ${action}@${revision} is not the reviewed action commit`,
      );
    }
  }
});

test("CodeQL sub-actions stay on one release and update as one Dependabot group", () => {
  const workflow = readFileSync(new URL("../.github/workflows/codeql.yml", import.meta.url), "utf8");
  const revisions = [...workflow.matchAll(/github\/codeql-action\/[^@\s]+@([^\s#]+)/g)].map(
    (match) => match[1]!,
  );
  assert.ok(revisions.length > 1, "the CodeQL workflow must keep every sub-action under this gate");
  assert.equal(new Set(revisions).size, 1, "every CodeQL sub-action must use the same release commit");

  const dependabot = parse(
    readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8"),
  ) as {
    updates?: Array<{
      "package-ecosystem"?: string;
      groups?: Record<string, { patterns?: string[] }>;
    }>;
  };
  const githubActions = dependabot.updates?.find(
    (update) => update["package-ecosystem"] === "github-actions",
  );
  assert.deepEqual(
    githubActions?.groups?.["codeql-action"]?.patterns,
    ["github/codeql-action*"],
    "Dependabot must group every CodeQL sub-action into one pull request",
  );
});

test("the read-only CI checkout never persists repository credentials", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const checkoutSteps = workflow.split(/\n(?=\s*- name: Checkout\s*$)/m).slice(1);
  assert.equal(checkoutSteps.length, 1, "CI must keep its checkout step under this gate");
  const checkoutBlock = checkoutSteps[0]!.split(/\n(?=\s*- name: )/m, 1)[0]!;
  assert.match(
    checkoutBlock,
    /^\s*persist-credentials:\s*false\s*$/m,
    "the read-only CI checkout must disable persisted credentials",
  );
});
