/** Read fresh owner, direct-share and group-share decisions only for this slice when principals are supplied. */
export declare function projectEventViewers(projectId: string, userIds?: readonly string[]): Promise<ReadonlySet<string>>;
/** Authorize this subscriber and read its display name in one fresh SQL snapshot, without caching grants. */
export declare function projectPresenceMember(projectId: string, userId: string): Promise<{
    displayName: string;
} | null>;
