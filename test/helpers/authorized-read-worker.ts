import pg from 'pg';
import { PmClient } from '@unbrained/pm-cli/sdk';

// A separate OS process commits the concurrent change while the parent holds a real SDK read.
const [action, project, principal] = process.argv.slice(2);
if (action === 'update-item') {
  await new PmClient({ pmRoot: project, noExtensions: true, author: 'read-worker' }).update(principal, { title: 'Changed by independent writer' });
} else {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    if (action === 'revoke') await db.query('DELETE FROM pm_project_shares WHERE project_id=$1 AND shared_with_user_id=$2', [project, principal]);
    else if (action === 'downgrade') await db.query("UPDATE pm_project_shares SET permission='view' WHERE project_id=$1 AND shared_with_user_id=$2", [project, principal]);
    else if (action === 'rebind') await db.query("UPDATE pm_projects SET slug=slug || '-rebound' WHERE id=$1", [project]);
    else throw new Error('Unknown fixture action');
  } finally { await db.end(); }
}
