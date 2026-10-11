import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { isScalar, parse, parseDocument, visit } from "yaml";

/** Owners permitted to supply executable workflow actions. */
const TRUSTED_ACTION_OWNERS = new Set(["actions", "github", "oven-sh", "dependabot"]);

/** Approved action names; updates may change pins without adding executable suppliers. */
const TRUSTED_ACTIONS = new Set([
  "actions/checkout", "actions/setup-node", "oven-sh/setup-bun",
  "github/codeql-action/init", "github/codeql-action/analyze",
  "dependabot/fetch-metadata",
]);

/** Workflow files shipped by this repository. */
const WORKFLOW_FILES = readdirSync(new URL("../.github/workflows", import.meta.url))
  .filter((file) => /\.ya?ml$/.test(file));

/**
 * Check parsed YAML action references so quoting and compact steps cannot bypass
 * the immutable-pin, release-comment or supplier policy. CodeQL sub-actions must
 * agree on both commit and documented release. A pin update needs only the
 * workflow edit; adding a supplier still requires an explicit policy change.
 * Returns the validated references for checks that require specific sub-actions.
 */
function assertWorkflowActionPins(workflow: string, file: string): ReadonlyArray<{ action: string; revision: string; version: string }> {
  const document = parseDocument(workflow);
  assert.equal(document.errors.length, 0, `${file}: workflow YAML must parse`);
  const pins: Array<{ action: string; revision: string; version: string }> = [];
  const codeqlReleases = new Set<string>();
  visit(document, {
    /** Validate every action scalar, retaining its parsed release comment. */
    Pair(_key, pair) {
      if (!isScalar(pair.key) || pair.key.value !== "uses") return;
      assert.ok(isScalar(pair.value) && typeof pair.value.value === "string", `${file}: uses must be a literal action reference`);
      const reference = pair.value.value;
      const match = /^([^@\s]+)@([0-9a-fA-F]{40})$/.exec(reference);
      assert.ok(match, `${file}: ${reference} must pin a full 40-character commit SHA`);
      const action = match[1]!;
      assert.ok(TRUSTED_ACTION_OWNERS.has(action.split("/")[0]!), `${file}: action owner is not allowed: ${action}`);
      assert.ok(TRUSTED_ACTIONS.has(action), `${file}: action is not allowed: ${action}`);
      const version = pair.value.comment?.trim() ?? "";
      assert.match(version, /^v(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/, `${file}: ${action} must document a valid release version`);
      const revision = match[2]!.toLowerCase();
      pins.push({ action, revision, version });
      if (action.startsWith("github/codeql-action/")) codeqlReleases.add(`${revision} ${version}`);
    },
  });
  assert.ok(pins.length > 0, `${file} must exercise the action-pin gate`);
  assert.ok(codeqlReleases.size <= 1, `${file}: CodeQL sub-actions must use one commit and version`);
  return pins;
}

test("every external workflow action has an immutable pin, release version and approved supplier", () => {
  assert.ok(WORKFLOW_FILES.length > 0, "workflow discovery cannot pass vacuously");
  for (const file of WORKFLOW_FILES) {
    const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    assertWorkflowActionPins(workflow, file);
  }
});

test("action policy rejects unsafe pins, missing releases and unapproved suppliers", () => {
  const pin = "a".repeat(40);
  const invalidReferences = [
    `actions/setup-node@${pin.slice(1)} # v7.1.0`,
    `actions/setup-node@${"g".repeat(40)} # v7.1.0`,
    "actions/setup-node@v7.1.0 # v7.1.0",
    `actions/setup-node@${pin}`,
    `actions/setup-node@${pin} # vlatest`,
    `actions/setup-node@${pin} # v07.1.0`,
    `actions/setup-node@${pin} # v7.1.0 reviewed`,
    `untrusted/setup-node@${pin} # v7.1.0`,
    `actions/unapproved@${pin} # v7.1.0`,
    "[actions/setup-node]",
    '"actions/setup-node@v7" # v7',
  ];
  for (const reference of invalidReferences) {
    assert.throws(() => assertWorkflowActionPins(`steps:\n  - uses: ${reference}\n`, "fixture"), /AssertionError/, reference);
  }
  assert.throws(() => assertWorkflowActionPins("steps: []", "fixture"), /must exercise/);
  assert.throws(() => assertWorkflowActionPins("steps: [", "fixture"), /must parse/);
  for (const [sha, version] of [["b".repeat(40), "v4.38.2"], [pin, "v4.39.0"]]) {
    assert.throws(() => assertWorkflowActionPins(
      `steps:\n  - uses: github/codeql-action/init@${pin} # v4.38.2\n  - uses: github/codeql-action/analyze@${sha} # ${version}\n`,
      "fixture",
    ), /CodeQL sub-actions must use one commit and version/);
  }
});

test("CodeQL sub-actions stay on one release and update as one Dependabot group", () => {
  const workflow = readFileSync(new URL("../.github/workflows/codeql.yml", import.meta.url), "utf8");
  const revisions = assertWorkflowActionPins(workflow, "codeql.yml")
    .filter((pin) => pin.action.startsWith("github/codeql-action/"))
    .map((pin) => pin.revision);
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
