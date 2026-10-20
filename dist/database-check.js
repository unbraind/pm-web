import pg from "pg";
import { databaseConfigIssues, postgresPort } from "./startup-config.js";
/** Schema revision recorded after all idempotent startup migrations complete. */
export const DATABASE_SCHEMA_VERSION = 1;
/** Diagnose configuration, connectivity and schema without changing the database. */
export async function checkDatabase() {
    const issues = databaseConfigIssues();
    if (issues.length)
        return { name: "database", ok: false, detail: `configured: no; reachable: unchecked; schema version: unchecked. ${issues.join(" ")}` };
    let client;
    let reachable = false;
    try {
        client = new pg.Client({
            ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
                host: process.env.POSTGRES_HOST, database: process.env.POSTGRES_DB,
                port: postgresPort(), user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD,
            }),
            connectionTimeoutMillis: 2000, query_timeout: 2000, statement_timeout: 2000,
        });
        await client.connect();
        await client.query("SELECT 1");
        reachable = true;
        const table = await client.query("SELECT to_regclass('pm_web_schema_version')::text AS present");
        const version = table.rows[0].present
            ? (await client.query("SELECT version FROM pm_web_schema_version WHERE singleton = TRUE")).rows[0]?.version
            : undefined;
        const ok = version === DATABASE_SCHEMA_VERSION;
        const guidance = ok ? "" : version !== undefined && version > DATABASE_SCHEMA_VERSION
            ? " The database schema is newer than this binary; use a compatible pm-web release."
            : " Run pm web to apply the packaged schema migrations.";
        return { name: "database", ok, detail: `configured: yes; reachable: yes; schema version: ${version ?? "missing"} (expected ${DATABASE_SCHEMA_VERSION}).${guidance}` };
    }
    catch {
        return { name: "database", ok: false, detail: `configured: yes; reachable: ${reachable ? "yes" : "no"}; schema version: unchecked. Check DATABASE_URL or POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER and POSTGRES_PASSWORD; verify PostgreSQL access and schema permissions.` };
    }
    finally {
        await client?.end().catch(() => undefined);
    }
}
//# sourceMappingURL=database-check.js.map