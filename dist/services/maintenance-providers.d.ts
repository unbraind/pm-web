/** Maintenance actions and the bundled commands that implement them. */
declare const PROVIDERS: {
    readonly "comments-audit": {
        readonly provider: "pm-governance-audit";
        readonly command: "item audit-comments";
        readonly owner: "builtin-governance-audit";
    };
    readonly normalize: {
        readonly provider: "pm-governance-audit";
        readonly command: "normalize";
        readonly owner: "builtin-governance-audit";
    };
    readonly reindex: {
        readonly provider: "pm-search-advanced";
        readonly command: "reindex";
        readonly owner: "builtin-search-advanced";
    };
};
/** The supported maintenance action names. */
export type MaintenanceAction = keyof typeof PROVIDERS;
/** Role-aware availability returned by the extensions endpoint and refusals. */
export interface MaintenanceCapability {
    available: boolean;
    provider: string;
    hint: string;
    installAction?: {
        method: "POST";
        url: string;
    };
}
/** Forget capabilities after an explicit package mutation in this project. */
export declare function invalidateMaintenanceCapabilities(projectDir: string): void;
/** Inspect available provider commands without installing or enabling packages. */
export declare function readMaintenanceCapabilities(project: {
    ownerUserId: string;
    slug: string;
    permission: string;
}, projectId: string): Promise<Record<MaintenanceAction, MaintenanceCapability>>;
export {};
