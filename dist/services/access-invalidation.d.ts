/** Broadcast only a content-free access signal; the existing fanout rechecks each viewer before delivery. */
export declare function invalidateProjectAccess(projectId: string): void;
/** Capture group-dependent project identities before membership or cascade deletion changes them. */
export declare function groupAccessProjects(groupId: string): Promise<string[]>;
/** Capture all project grants a removed account can affect, without reading project content. */
export declare function userAccessProjects(userId: string): Promise<string[]>;
