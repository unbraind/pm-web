import assert from "node:assert/strict";
import test from "node:test";
import { createPmCliExpectedError, EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk";
import { PmCliError } from "../src/services/pm-runner.ts";
import { projectReadFailure } from "../src/routes/pm.ts";

test("project read failures map structural SDK expected errors to 404 and 400", () => {
  // A structurally expected error, as a separately installed SDK copy throws it: the public shape without this copy's class.
  const foreign = (exitCode: number): Error => Object.assign(new Error("expected"), { name: "PmCliError", exitCode, context: { code: "fixture" } });
  const notFound = foreign(EXIT_CODE.NOT_FOUND), usage = foreign(EXIT_CODE.USAGE);
  assert.ok(isPmCliExpectedError(notFound) && !(notFound instanceof PmCliError), "fixture is structural only");
  assert.deepEqual(projectReadFailure(notFound), { status: 404, body: { error: "Item not found" } });
  assert.deepEqual(projectReadFailure(usage), { status: 400, body: { error: "Invalid item id or historical reference" } });
  // Must allow: other expected errors and plain failures stay unavailable reads, answered as 503 by the route.
  assert.equal(projectReadFailure(createPmCliExpectedError("Conflict", { exitCode: EXIT_CODE.CONFLICT })), undefined);
  assert.equal(projectReadFailure(new Error("provider down")), undefined);
});
