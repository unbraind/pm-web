/** Keep the environment table aligned with the supported startup configurations. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { databaseConfigIssues, startupConfigIssues } from "../src/startup-config.ts";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/** Read one environment row while keeping requirement and description assertions separate. */
function environmentRow(variable: string): { required: string; description: string } {
  const row = readme.split("\n").find((line) => line.startsWith(`| ${variable} |`));
  assert.ok(row, `Missing environment row: ${variable}`);
  const cells = row.split("|").map((cell) => cell.trim());
  return { required: cells[2], description: cells[3] };
}

test("README database requirements describe URL and discrete settings as alternatives", () => {
  assert.deepEqual(databaseConfigIssues({ DATABASE_URL: "postgres://fixture@db.example/fixture" }), []);
  assert.deepEqual(databaseConfigIssues({ POSTGRES_HOST: "db.example", POSTGRES_DB: "fixture" }), []);
  assert.ok(databaseConfigIssues({ POSTGRES_HOST: "db.example" }).length);
  assert.ok(databaseConfigIssues({ POSTGRES_DB: "fixture" }).length);
  const url = environmentRow("`DATABASE_URL`");
  assert.match(url.required, /^Unless\b.*`POSTGRES_HOST`.*`POSTGRES_DB`/);
  const discrete = environmentRow("`POSTGRES_HOST` / `POSTGRES_DB`");
  assert.match(discrete.required, /^Unless\b.*`DATABASE_URL`/);
  assert.match(discrete.description, /set both/i);
  assert.equal(environmentRow("`POSTGRES_PORT`").required, "No");
  assert.match(environmentRow("`POSTGRES_PORT`").description, /default: `5432`/);
  assert.equal(environmentRow("`POSTGRES_USER` / `POSTGRES_PASSWORD`").required, "No");
});

test("README signing secret requirement is limited to production", () => {
  const database = { DATABASE_URL: "postgres://fixture@db.example/fixture" };
  assert.deepEqual(startupConfigIssues({ ...database, NODE_ENV: "development" }), []);
  assert.match(startupConfigIssues({ ...database, NODE_ENV: "production" }).join(), /JWT_SECRET/);
  const secret = environmentRow("`JWT_SECRET`");
  assert.equal(secret.required, "In production");
  assert.match(secret.description, /unset.*random development secret outside production/);
});

test("README OIDC requirements preserve non-production soft disable", () => {
  const partial = { DATABASE_URL: "postgres://fixture@db.example/fixture", JWT_SECRET: "synthetic-signing-secret",
    OIDC_CLIENT_ID: "fixture" };
  for (const mode of ["development", "test"]) {
    assert.deepEqual(startupConfigIssues({ ...partial, NODE_ENV: mode }), []);
  }
  assert.match(startupConfigIssues({ ...partial, NODE_ENV: "production" }).join(), /OIDC_ISSUER/);
  const issuer = environmentRow("`OIDC_ISSUER`");
  assert.equal(issuer.required, "With OIDC");
  assert.match(issuer.description, /incomplete or invalid.*fail startup in production.*soft-disabled outside production/);
});
