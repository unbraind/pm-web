declare const router: import("express-serve-static-core").Router;
/**
 * Check if a user has access to a project (either as owner or via share).
 * Returns the project row with an additional `ownerUserId` field indicating
 * whose pm data directory to use when running pm CLI commands.
 */
export declare function verifyProjectAccess(userId: string, projectId: string): Promise<{
    id: string;
    name: string;
    slug: string;
    description: string;
    prefix: string;
    ownerUserId: string;
    permission: string;
} | null>;
export { router as projectsRouter };
//# sourceMappingURL=projects.d.ts.map