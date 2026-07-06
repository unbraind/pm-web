export type BoardItem = {
    id: string;
    title?: string;
    status?: string;
    tags?: string[] | string;
    body?: string;
    description?: string;
};
export declare function normalizeStatusKey(value: unknown): string;
export declare function normalizeItemTags(value: unknown): string[];
export declare function boardColumns<T extends BoardItem>(items: T[], statuses: string[]): Array<{
    status: string;
    items: T[];
}>;
export declare function filterItemsByQuery<T extends BoardItem>(items: T[], query: string): T[];
//# sourceMappingURL=board.d.ts.map