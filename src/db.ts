import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  ...(process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.POSTGRES_HOST || "pm-telemetry-postgres",
        port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
        database: process.env.POSTGRES_DB,
      }),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

const bootstrapAdminEmail = (process.env.PM_WEB_BOOTSTRAP_ADMIN_EMAIL || "redacted@example.invalid")
  .trim()
  .toLowerCase();

export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pm_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pm_projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES pm_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT DEFAULT '',
      prefix TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, slug)
    );

    CREATE INDEX IF NOT EXISTS pm_projects_user_id ON pm_projects(user_id);

    CREATE TABLE IF NOT EXISTS pm_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES pm_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pm_group_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID NOT NULL REFERENCES pm_groups(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES pm_users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      invited_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS pm_project_shares (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
      shared_with_user_id UUID REFERENCES pm_users(id) ON DELETE CASCADE,
      shared_with_group_id UUID REFERENCES pm_groups(id) ON DELETE CASCADE,
      permission TEXT NOT NULL DEFAULT 'view',
      shared_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT share_target CHECK (
        (shared_with_user_id IS NOT NULL AND shared_with_group_id IS NULL) OR
        (shared_with_user_id IS NULL AND shared_with_group_id IS NOT NULL)
      ),
      UNIQUE(project_id, shared_with_user_id),
      UNIQUE(project_id, shared_with_group_id)
    );
  `);

  // Migrations for new columns (idempotent)
  await pool.query(`
    ALTER TABLE pm_users ADD COLUMN IF NOT EXISTS github_token TEXT;
    ALTER TABLE pm_users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE pm_projects ADD COLUMN IF NOT EXISTS github_owner TEXT;
    ALTER TABLE pm_projects ADD COLUMN IF NOT EXISTS github_repo TEXT;
    ALTER TABLE pm_projects ADD COLUMN IF NOT EXISTS github_sync_enabled BOOLEAN DEFAULT FALSE;
  `);

  await pool.query(
    `CREATE TABLE IF NOT EXISTS pm_admin_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id UUID NOT NULL REFERENCES pm_users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`
  );

  await pool.query(
    `CREATE INDEX IF NOT EXISTS pm_admin_audit_created_at ON pm_admin_audit(created_at DESC)`
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pm_github_item_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
      pm_item_id TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      issue_url TEXT NOT NULL,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, pm_item_id)
    );
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS pm_github_item_links_project ON pm_github_item_links(project_id)`
  );

  await pool.query(
    `UPDATE pm_users SET is_admin = TRUE, updated_at = NOW() WHERE lower(email) = lower($1)`,
    [bootstrapAdminEmail]
  );
}
