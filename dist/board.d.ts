/**
 * Minimal projection of a pm item used by the pure board/search helpers: a
 * stable id plus the optional text fields the kanban columns and full-text
 * filter read. Callers cast richer item shapes to this narrow view.
 */
export type BoardItem = {
    id: string;
    title?: string;
    status?: string;
    tags?: string[] | string;
    body?: string;
    description?: string;
};
/**
 * Coerce an arbitrary status value into a normalized board-column key.
 *
 * A non-empty string is trimmed and used; anything else (or a blank string)
 * falls back to `"open"`. The result is then lowercased and has each run of
 * whitespace or hyphens replaced with a single underscore, so `"In Progress"`,
 * `"in-progress"` and `"in progress"` all map to `in_progress`.
 *
 * @param value - The raw `status` field from an item; type is `unknown` because
 *   imported items can carry non-string values.
 * @returns The normalized, lowercase, underscore-separated status key.
 */
export declare function normalizeStatusKey(value: unknown): string;
/**
 * Normalize an item's `tags` field into a trimmed, blank-free string array.
 *
 * An array has each entry stringified and trimmed; a string is split on commas;
 * any other type yields an empty array. Empty fragments are dropped in every
 * case, so `"a, ,b"` becomes `["a", "b"]`.
 *
 * @param value - The raw `tags` field from an item.
 * @returns The list of non-empty tag strings.
 */
export declare function normalizeItemTags(value: unknown): string[];
/**
 * Group items into board columns keyed by the workspace's actual statuses.
 *
 * The supplied `statuses` (from `pm contracts`) define the ordered columns; if
 * none are given a default `open / in_progress / blocked / closed` set is used.
 * Each status is matched case- and separator-insensitively via
 * {@link normalizeStatusKey}, so items land in the intended column regardless of
 * capitalization. Items whose status matches no known column are collected into
 * a trailing `(other)` column so nothing is silently dropped. Columns are
 * returned in declared-status order, with `(other)` appended when first needed.
 *
 * @param items - Items to distribute.
 * @param statuses - The workspace's declared status labels.
 * @returns Columns in declared-status order, each carrying its items.
 */
export declare function boardColumns<T extends BoardItem>(items: T[], statuses: string[]): Array<{
    status: string;
    items: T[];
}>;
/**
 * Case-insensitive substring filter over an item's text fields.
 *
 * Matches against the concatenation of id, title, tags (normalized), body and
 * description, lowercased. A blank query short-circuits and returns the input
 * array unchanged. The original items are returned by reference, not copied.
 *
 * @param items - Items to filter.
 * @param query - Free-text query; surrounding whitespace is ignored.
 * @returns The items whose text fields contain the query substring.
 */
export declare function filterItemsByQuery<T extends BoardItem>(items: T[], query: string): T[];
