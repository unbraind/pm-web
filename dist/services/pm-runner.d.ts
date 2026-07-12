export declare function getProjectDir(userId: string, slug: string): string;
export declare function initProject(userId: string, slug: string, prefix: string): Promise<void>;
export declare function projectExists(userId: string, slug: string): boolean;
export interface PmRunOptions {
    args: string[];
    userId: string;
    slug: string;
    input?: string;
    jsonOutput?: boolean;
    timeoutMs?: number;
}
export interface PmRunResult {
    stdout: string;
    stderr: string;
    ok: boolean;
    parsed?: unknown;
}
export interface EnsureGraphExtensionResult {
    ok: boolean;
    installed: boolean;
    active: boolean;
    error?: string;
}
export declare function ensureGraphExtension(userId: string, slug: string): Promise<EnsureGraphExtensionResult>;
export declare function runPm(opts: PmRunOptions): Promise<PmRunResult>;
export declare function deleteProjectDir(userId: string, slug: string): void;
