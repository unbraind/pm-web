/** Read fresh owner, direct-share and group-share viewers once for a project burst. */
export declare function projectEventViewers(projectId: string): Promise<ReadonlySet<string>>;
