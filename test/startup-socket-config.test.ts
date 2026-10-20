/** Keep startup validation compatible with the installed PostgreSQL driver's socket syntax. */
import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { databaseConfigIssues as sourceIssues } from "../src/startup-config.ts";
import { databaseConfigIssues as builtIssues } from "../dist/startup-config.js";

for (const [name, connectionString] of [
  ["credentialed empty-host URL", "postgres://fixture:synthetic-password@/fixture?host=/var/run/postgresql"],
  ["bare socket path", "/var/run/postgresql fixture"],
  ["socket URL", "socket:/var/run/postgresql?db=fixture"],
  ["repeated host with an empty first value", "postgres:///fixture?host=&host=/var/run/postgresql"],
  ["repeated host with a blank first value", "postgres:///fixture?host=%20&host=/var/run/postgresql"],
] as const) {
  test(`source and built preflight accept pg's ${name}`, () => {
    const client = new pg.Client({ connectionString });
    assert.equal(client.host, "/var/run/postgresql", "the real driver must select the socket directory");
    assert.equal(client.database, "fixture");
    for (const validate of [sourceIssues, builtIssues]) {
      assert.deepEqual(validate({ DATABASE_URL: connectionString }), []);
    }
  });
}

test("socket fallbacks preserve invalid-protocol, missing-host and fragment diagnostics without credentials", () => {
  for (const connectionString of [
    "socket:", "socket:?db=fixture", "postgres://fixture:synthetic-password@/fixture",
    "postgres://fixture:synthetic-password@/fixture?host=%20", "ftp://fixture:synthetic-password@/fixture?host=/var/run/postgresql",
    "socket:/var/run/postgresql?db=fixture#fragment", "postgres://fixture:synthetic-password@/fixture?host=/var/run/postgresql#fragment",
    "postgres://fixture:synthetic-password@[/fixture",
    "postgres:///fixture?host=/var/run/postgresql&host=%20",
  ]) {
    for (const validate of [sourceIssues, builtIssues]) {
      const issues = validate({ DATABASE_URL: connectionString });
      assert.equal(issues.length, 1);
      assert.match(issues[0], /DATABASE_URL/);
      assert.doesNotMatch(issues[0], /synthetic-password|fixture|postgres:\/\//);
    }
  }
});
