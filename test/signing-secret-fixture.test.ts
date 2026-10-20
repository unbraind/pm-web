/** Prove assertion failures cannot contaminate later server startup tests. */
import assert from "node:assert/strict";
import test from "node:test";
import { withEmptySigningSecret } from "./helpers/empty-signing-secret.ts";

test("empty signing-secret fixture restores present and absent settings after assertion failures", async () => {
  const original = process.env.JWT_SECRET;
  try {
    for (const saved of ["synthetic-original-signing-secret", undefined]) {
      if (saved === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = saved;
      await assert.rejects(withEmptySigningSecret(async () => {
        assert.equal(process.env.JWT_SECRET, "");
        await Promise.resolve();
        assert.fail("synthetic startup assertion failure");
      }), { name: "AssertionError", message: "synthetic startup assertion failure" });
      assert.equal(process.env.JWT_SECRET, saved, "restore before a later startup assertion runs");
      assert.equal(await withEmptySigningSecret(async () => process.env.JWT_SECRET), "");
      assert.equal(process.env.JWT_SECRET, saved, "restore after a successful assertion too");
    }
  } finally {
    if (original === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = original;
  }
});
