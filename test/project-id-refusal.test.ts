/** Malformed mount identifiers refuse before any authorization SQL, across project routers. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from '../src/db.ts';
import { authedFetch, ensureSchema, ProjectFixtureResources } from './helpers/pg-harness.ts';

test('malformed project ids return typed 400 without querying the pool', async t => {
  await ensureSchema();
  const resources = new ProjectFixtureResources(t);
  const owner = await resources.user(); const server = await resources.server();
  // Keep real SQL available while counting every call made by each HTTP request.
  const query = t.mock.method(pool, 'query');
  for (const id of ['malformed', '00000000-0000-0000-0000-00000000000z']) {
    for (const [method, route] of [
      ['GET', 'pm/board'], ['HEAD', 'pm/board'], ['GET', 'pm/get/synthetic'],
      ['GET', 'pm/at/synthetic/1'], ['GET', 'pm/comments/synthetic'], ['GET', 'pm/notes/synthetic'],
      ['GET', 'pm/history/synthetic'], ['GET', 'pm/search?q=synthetic'], ['POST', 'pm/create'],
      ['PATCH', 'pm/presence/synthetic'], ['GET', 'pm/events'], ['GET', 'pm/presence'],
      ['GET', 'pm/evidence/synthetic'], ['GET', 'pm/contracts'], ['POST', 'pm/permission-impact'], ['GET', 'pm/agent-context'],
      ['GET', 'pm/schema'], ['GET', 'pm/context'], ['GET', 'pm/graph'],
      ['GET', 'extensions'], ['POST', 'extensions/synthetic/install'],
    ]) {
      const before = query.mock.callCount();
      const response = await authedFetch(server, owner, `/api/projects/${id}/${route}`, { method });
      assert.equal(response.status, 400, `${method} ${route}`);
      if (method !== 'HEAD') assert.deepEqual(await response.json(), { error: 'Invalid projectId' });
      assert.equal(query.mock.callCount(), before, 'proof:invalid_project_no_query');
    }
  }
});
