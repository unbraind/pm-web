// Pure, dependency-free helpers for the kanban board and search endpoints.
// Kept in their own module (no db/neo4j imports) so they are unit-testable
// without booting the server or a database.
// Group items into board columns keyed by the workspace's actual statuses
// (from `pm contracts`), so the kanban board reflects whatever statuses the
// installed pm CLI + extensions define. Items with an unlisted status fall into
// a trailing "(other)" column so nothing is silently dropped.
export function boardColumns(items, statuses) {
    const known = statuses.length > 0 ? statuses : ["open", "in_progress", "blocked", "closed"];
    const columns = new Map();
    for (const s of known)
        columns.set(s, []);
    const OTHER = "(other)";
    for (const item of items) {
        const s = item.status ?? "open";
        if (columns.has(s))
            columns.get(s).push(item);
        else {
            if (!columns.has(OTHER))
                columns.set(OTHER, []);
            columns.get(OTHER).push(item);
        }
    }
    return [...columns.entries()].map(([status, list]) => ({ status, items: list }));
}
// Case-insensitive full-text filter over id, title, tags and body.
export function filterItemsByQuery(items, query) {
    const q = query.trim().toLowerCase();
    if (!q)
        return items;
    return items.filter((item) => {
        const hay = [
            item.id,
            item.title ?? "",
            (item.tags ?? []).join(" "),
            item.body ?? "",
        ].join(" ").toLowerCase();
        return hay.includes(q);
    });
}
//# sourceMappingURL=board.js.map