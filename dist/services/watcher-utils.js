/**
 * Shared primitives for the workspace watcher services.
 *
 * The mutation-event watcher and the filesystem sweep watcher iterate the same
 * active-project list and resolve the same per-project workspace directories.
 * Both loops previously carried byte-identical helpers, which the duplication
 * gate flags; this module is the single copy.
 */
/**
 * Read a positive-integer environment variable, with a fallback.
 *
 * Returns the parsed integer when the variable is set and the raw value parses
 * as a positive integer via `Number.parseInt`; otherwise returns `fallback`.
 * Because `parseInt` parses a leading integer prefix, values like `"500ms"`
 * parse as `500` and `"1.5"` truncates to `1`. Non-numeric, zero, or negative
 * values fall back rather than throwing.
 *
 * @param name - The environment variable name.
 * @param fallback - Value used when unset or invalid.
 * @returns The parsed positive integer, or the fallback.
 */
export function positiveIntEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
/**
 * Resolve a project's workspace directory through a shared cache.
 *
 * A cache miss resolves once and stores the result (including a stored `null`
 * for an unresolvable project, which is distinct from the `undefined` of a
 * project never looked up); a hit returns the cached value untouched.
 *
 * @param projectId - The project to resolve.
 * @param cache - Cache shared across ticks, keyed by project id.
 * @param resolveDir - Resolver returning the directory or `null`.
 * @returns The directory, or `null` when the project has no workspace.
 */
export async function cachedProjectDir(projectId, cache, resolveDir) {
    const cached = cache.get(projectId);
    if (cached !== undefined)
        return cached;
    const dir = await resolveDir(projectId);
    cache.set(projectId, dir);
    return dir;
}
/**
 * Delete entries whose key is no longer an active project id.
 *
 * @param cache - Cache to prune in place.
 * @param active - The ids returned by this tick's active-project query.
 */
export function dropInactive(cache, active) {
    for (const id of [...cache.keys()])
        if (!active.has(id))
            cache.delete(id);
}
//# sourceMappingURL=watcher-utils.js.map