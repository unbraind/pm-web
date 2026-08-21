import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** Reviewed action commits allowed in this repository's workflows. */
const TRUSTED_ACTION_COMMITS = new Map<string, string>([
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
  ["oven-sh/setup-bun", "0c5077e51419868618aeaa5fe8019c62421857d6"],
]);

/** Workflow files shipped by this repository. */
const WORKFLOW_FILES = ["ci.yml", "release.yml"] as const;

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
