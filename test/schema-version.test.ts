/** Verify revision monotonicity through real source, built and packaged migrations. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import pg from "pg";
import { DATABASE_SCHEMA_VERSION } from "../src/database-check.ts";

const execute = promisify(execFile);

for (const mode of ["source", "built", "packaged SQL"] as const) {
  test(`${mode} schema initialization preserves newer revisions and upgrades older ones`, { timeout: 60_000 }, async (t) => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const schema = `revision_${randomUUID().replaceAll("-", "")}`;
    t.after(async () => {
      try { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
      finally { await client.end(); }
    });
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    /** Apply the actual entry point to this test's isolated schema. */
    const initialize = async () => {
      if (mode === "packaged SQL") await client.query(await readFile("sql/schema.sql", "utf8"));
      else await execute(process.execPath, [mode === "source" ? "scripts/init-test-schema.ts" : "test/helpers/init-built-schema.ts"], {
        env: { ...process.env, DATABASE_URL: url.href, PM_WEB_BOOTSTRAP_ADMIN_EMAIL: "" }, timeout: 30_000,
      });
    };
    /** Read the real stored singleton instead of inferring behavior from SQL text. */
    const version = async () => (await client.query<{ version: number }>("SELECT version FROM pm_web_schema_version WHERE singleton = TRUE")).rows[0]?.version;
    await initialize();
    assert.equal(await version(), DATABASE_SCHEMA_VERSION, "fresh schema must record this release's revision");
    const newer = DATABASE_SCHEMA_VERSION + 1;
    await client.query("UPDATE pm_web_schema_version SET version = $1", [newer]);
    await initialize();
    assert.equal(await version(), newer, "older migrations must not lower a newer stored revision");
    await initialize();
    assert.equal(await version(), newer, "repeated initialization must preserve the newer revision");
    await client.query("UPDATE pm_web_schema_version SET version = $1", [DATABASE_SCHEMA_VERSION - 1]);
    await initialize();
    assert.equal(await version(), DATABASE_SCHEMA_VERSION, "older revisions must still advance after migrations");
    await initialize();
    assert.equal(await version(), DATABASE_SCHEMA_VERSION, "current revisions must remain idempotent");
  });
}
