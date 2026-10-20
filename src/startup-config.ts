import { resolveOidcSettings } from "./oidc.ts";

/** Validate a numeric setting without reflecting its potentially private value. */
export function integerSetting(value: string, name: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}; set ${name} before starting.`);
  }
  return parsed;
}

/** Resolve the discrete PostgreSQL port, treating an empty setting as unset. */
export function postgresPort(env: NodeJS.ProcessEnv = process.env): number {
  return integerSetting(env.POSTGRES_PORT || "5432", "POSTGRES_PORT", 1, 65535);
}

/** Return all database configuration problems using setting names only. */
export function databaseConfigIssues(env: NodeJS.ProcessEnv = process.env): string[] {
  const issues: string[] = [];
  if (env.DATABASE_URL) {
    try {
      const url = new URL(env.DATABASE_URL);
      const host = url.searchParams.get("host") || url.hostname;
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !host.trim() || url.hash) throw new Error();
    } catch {
      issues.push("DATABASE_URL must be a PostgreSQL URL with a host; export DATABASE_URL with your PostgreSQL connection settings.");
    }
  } else {
    for (const name of ["POSTGRES_HOST", "POSTGRES_DB"]) {
      if (!env[name]?.trim()) issues.push(`${name} is missing; export ${name}, or export DATABASE_URL instead.`);
    }
    if (issues.length) issues.unshift("DATABASE_URL is not set. pm-web requires PostgreSQL.");
    try { postgresPort(env); }
    catch (error) { issues.push((error as Error).message); }
  }
  return issues;
}

/** Collect startup errors before importing modules that open resources or require secrets. */
export function startupConfigIssues(env: NodeJS.ProcessEnv = process.env): string[] {
  const issues = databaseConfigIssues(env);
  for (const [name, fallback, min, max] of [
    ["PORT", "4000", 0, 65535], ["PM_WEB_DB_POOL_MAX", "20", 2, 10000],
    ["PM_WEB_STARTUP_TIMEOUT_MS", "30000", 1, 300000],
  ] as const) {
    try { integerSetting(env[name] || fallback, name, min, max); }
    catch (error) { issues.push((error as Error).message); }
  }
  if (env.JWT_SECRET === "" || (env.NODE_ENV === "production" && !env.JWT_SECRET?.trim())) {
    issues.push("JWT_SECRET is required in production; export JWT_SECRET with a private random signing secret.");
  }
  try {
    const oidc = resolveOidcSettings(env);
    if (!oidc.enabled && oidc.reason && env.NODE_ENV === "production") issues.push(`${oidc.reason} Set the named OIDC_* environment variables or unset OIDC configuration.`);
  } catch (error) {
    issues.push(`${(error as Error).message} Set the named OIDC_* environment variables or unset OIDC configuration.`);
  }
  return issues;
}

/** Remove connection strings and configured credentials from bounded child diagnostics. */
export function redactStartupLog(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let safe = text.replace(/postgres(?:ql)?:\/\/[^\s"'\\]+/gi, "[redacted PostgreSQL URL]");
  for (const [name, value] of Object.entries(env)) {
    if (value && /PASSWORD|SECRET|TOKEN|API_?KEY|AUTHORIZATION|CREDENTIAL|DATABASE_URL|POSTGRES_USER/i.test(name)) safe = safe.split(value).join("[redacted]");
  }
  return safe;
}
