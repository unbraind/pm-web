/** Validate the real preview against immutable public tracker bytes in a plain scratch workspace. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listAllComplete } from '@unbrained/pm-cli/sdk';
import { initSchema, pool } from '../src/db.ts';
import { previewPermissionImpact } from '../src/services/permission-impact.ts';
import { withPublicTrackerCopy } from './public-tracker-copy.ts';

await initSchema();
const root = await mkdtemp(path.join(os.tmpdir(), 'permission-public-'));
const previous = process.env.PROJECTS_ROOT;
process.env.PROJECTS_ROOT = root;
const owner = randomUUID(), viewer = randomUUID(), project = randomUUID(), share = randomUUID();
try {
  await pool.query("INSERT INTO pm_users(id,email,display_name,password_hash) VALUES($1,$2,'Synthetic owner','synthetic'),($3,$4,'Synthetic viewer','synthetic')", [owner, `${owner}@example.test`, viewer, `${viewer}@example.test`]);
  await pool.query("INSERT INTO pm_projects(id,user_id,name,slug,prefix) VALUES($1,$2,'Public tracker copy','public-copy','public')", [project, owner]);
  await pool.query("INSERT INTO pm_project_shares(id,project_id,shared_with_user_id,permission) VALUES($1,$2,$3,'edit')", [share, project, viewer]);
  const result = await withPublicTrackerCopy(async ({ cwd, pmRoot }) => {
    await mkdir(path.join(root, owner)); await symlink(cwd, path.join(root, owner, 'public-copy'));
    const start = performance.now(), corpus = await listAllComplete({}, { cwd, pmRoot, noExtensions: true });
    const downgrade = await previewPermissionImpact(project, owner, { shareId: share, permission: 'view', limit: 20 });
    const removal = await previewPermissionImpact(project, owner, { shareId: share, permission: 'none', limit: 20 });
    return { repository: 'unbraind/pm-web', sourceItems: corpus.items.length, sourcePlans: corpus.items.filter(item => item.type === 'Plan').length,
      downgrade: downgrade.counts, removal: removal.counts, firstPageBytes: Buffer.byteLength(JSON.stringify(removal)), returned: removal.losses.length,
      applied: removal.applied, unknownCapabilities: removal.unknownCapabilities, elapsedMs: Math.round(performance.now() - start) };
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.query('DELETE FROM pm_users WHERE id=ANY($1::uuid[])', [[owner, viewer]]); await pool.end();
  await rm(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.PROJECTS_ROOT; else process.env.PROJECTS_ROOT = previous;
}
