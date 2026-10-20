/** Validate a numeric setting without reflecting its potentially private value. */
export declare function integerSetting(value: string, name: string, min: number, max: number): number;
/** Return all database configuration problems using setting names only. */
export declare function databaseConfigIssues(env?: NodeJS.ProcessEnv): string[];
/** Collect startup errors before importing modules that open resources or require secrets. */
export declare function startupConfigIssues(env?: NodeJS.ProcessEnv): string[];
/** Remove connection strings and configured credentials from bounded child diagnostics. */
export declare function redactStartupLog(text: string, env?: NodeJS.ProcessEnv): string;
