/**
 * Real-Postgres regression coverage for GitHub issue imports.
 *
 * The import route runs through the production Express app with an edit
 * collaborator, while only outbound `api.github.com` calls are intercepted.
 * This proves malformed request values are rejected before they can steer the
 * project owner's token and that a valid integer still reaches the intended
 * repository issue endpoint.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { pool } from "../src/db.ts";
import {
  authedFetch,
  ensureSchema,
  seedProject,
  seedUser,
  seedUserShare,
  startApp,
  uniqueEmail,
} from "./helpers/pg-harness.ts";

test("github import rejects unsafe issue numbers before fetching and accepts an integer", async (t) => {
  await ensureSchema();
  const owner = await seedUser(uniqueEmail("github-owner"));
  const editor = await seedUser(uniqueEmail("github-editor"));
  const project = await seedProject(owner.id);
  await seedUserShare(project.id, editor.id, "edit");
  await pool.query(`UPDATE pm_users SET github_token = $1 WHERE id = $2`, ["owner-token", owner.id]);
  await pool.query(
    `UPDATE pm_projects SET github_owner = $1, github_repo = $2 WHERE id = $3`,
    ["octo owner", "project/repo", project.id],
  );

  const githubRequests: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.github.com/")) return realFetch(input, init);
    githubRequests.push(url);
    return new Response(JSON.stringify({ message: "Not Found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const server = await startApp();
  t.after(() => server.close());

  const rejectedCases: Array<{ label: string; body: unknown }> = [
    { label: "numeric string", body: { issueNumbers: ["1"] } },
    { label: "nested traversal", body: { issueNumbers: ["1/../../../../user/repos"] } },
    { label: "root traversal", body: { issueNumbers: ["../../../../user"] } },
    { label: "non-integer value", body: { issueNumbers: [null] } },
    { label: "negative integer", body: { issueNumbers: [-1] } },
    { label: "floating-point number", body: { issueNumbers: [1.5] } },
    { label: "zero", body: { issueNumbers: [0] } },
    { label: "integer above the upper bound", body: { issueNumbers: [2_147_483_648] } },
    { label: "missing array", body: {} },
    { label: "missing request body", body: undefined },
    { label: "empty array", body: { issueNumbers: [] } },
    { label: "oversized array", body: { issueNumbers: Array.from({ length: 51 }, (_, index) => index + 1) } },
  ];

  for (const rejected of rejectedCases) {
    const response = await authedFetch(server, editor, `/api/projects/${project.id}/github/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rejected.body === undefined ? undefined : JSON.stringify(rejected.body),
    });
    assert.equal(response.status, 400, `${rejected.label} must be rejected`);
    assert.equal(githubRequests.length, 0, `${rejected.label} must not issue a GitHub fetch`);
  }

  const valid = await authedFetch(server, editor, `/api/projects/${project.id}/github/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issueNumbers: [42] }),
  });
  assert.equal(valid.status, 200, "a valid integer keeps the import flow working");
  assert.deepEqual(githubRequests, [
    "https://api.github.com/repos/octo%20owner/project%2Frepo/issues/42",
  ]);
  assert.deepEqual(await valid.json(), { created: [], errors: ["#42: not found"], total: 1 });
});
