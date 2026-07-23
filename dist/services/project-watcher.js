import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pool } from "../db.js";
import { getProjectDir } from "./pm-runner.js";
import { deliverProjectEvent, getActiveProjectIds, wasSignaledWithin, } from "./sse.js";
const DEFAULT_INTERVAL_MS = 2_000;
const MIN_INTERVAL_MS = 500;
// Item-type directories that hold user-facing `.toon` items:
const ITEM_DIRS = [
    "tasks", "issues", "epics", "features", "chores",
    "decisions", "meetings", "milestones", "reminders", "events",
];
const MAX_FILES_PER_PROJECT = 8_000; // safety cap on stat work per project per tick
function positiveIntEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
async function safeMaxMtime(dir) {
    // dir is a project root: <PROJECTS_ROOT>/<userId>/<slug>
    const pmDir = path.join(dir, ".agents", "pm");
    let max = 0;
    let scanned = 0;
    const scan = async (subdir, ext) => {
        let entries;
        try {
            entries = await readdir(path.join(pmDir, subdir), { withFileTypes: true });
        }
        catch {
            return; // ENOENT etc — subdir may not exist
        }
        for (const entry of entries) {
            if (scanned >= MAX_FILES_PER_PROJECT)
                return;
            if (!entry.isFile() || !entry.name.endsWith(ext))
                continue;
            scanned += 1;
            try {
                const s = await stat(path.join(pmDir, subdir, entry.name));
                if (s.mtimeMs > max)
                    max = s.mtimeMs;
            }
            catch {
                // file vanished between readdir and stat — ignore
            }
        }
    };
    for (const d of ITEM_DIRS)
        await scan(d, ".toon");
    await scan("history", ".jsonl");
    return max;
}
async function defaultResolveProjectDir(projectId) {
    try {
        const res = await pool.query("SELECT user_id, slug FROM pm_projects WHERE id = $1", [projectId]);
        const row = res.rows[0];
        if (!row)
            return null;
        return getProjectDir(row.user_id, row.slug);
    }
    catch {
        return null;
    }
}
// Pure, testable cycle. Holds per-project baseline state across ticks.
export function createProjectWatchCycle(deps = {}) {
    const intervalMs = Math.max(MIN_INTERVAL_MS, deps.intervalMs ?? positiveIntEnv("PM_WATCH_INTERVAL_MS", DEFAULT_INTERVAL_MS));
    const suppressWindowMs = deps.suppressWindowMs ?? intervalMs * 2 + 3_000;
    const getIds = deps.getActiveProjectIds ?? getActiveProjectIds;
    const resolveDir = deps.resolveProjectDir ?? defaultResolveProjectDir;
    const readMax = deps.readMaxMtimeMs ?? safeMaxMtime;
    const signaled = deps.wasSignaledWithin ?? wasSignaledWithin;
    const emit = deps.emit ?? deliverProjectEvent;
    const onError = deps.onError ?? (() => undefined);
    const lastSeen = new Map();
    const dirCache = new Map();
    let inFlight = false;
    const tick = async () => {
        if (inFlight)
            return; // never overlap ticks
        inFlight = true;
        try {
            const ids = getIds();
            const active = new Set(ids);
            for (const id of [...lastSeen.keys()])
                if (!active.has(id))
                    lastSeen.delete(id);
            for (const id of [...dirCache.keys()])
                if (!active.has(id))
                    dirCache.delete(id);
            for (const projectId of ids) {
                try {
                    let dir = dirCache.get(projectId);
                    if (dir === undefined) {
                        dir = await resolveDir(projectId);
                        dirCache.set(projectId, dir);
                    }
                    if (!dir)
                        continue;
                    const maxMtime = await readMax(dir);
                    const prev = lastSeen.get(projectId);
                    if (prev === undefined) {
                        lastSeen.set(projectId, maxMtime); // baseline — never emit on first observation
                        continue;
                    }
                    if (maxMtime > prev) {
                        lastSeen.set(projectId, maxMtime);
                        if (!signaled(projectId, suppressWindowMs)) {
                            emit(projectId, { type: "workspace-changed", data: { source: "filesystem" } });
                        }
                    }
                }
                catch (err) {
                    onError(err);
                }
            }
        }
        finally {
            inFlight = false;
        }
    };
    return { tick, suppressWindowMs };
}
export function startProjectWatcher(deps = {}) {
    if (process.env.PM_WATCH_PROJECTS === "false")
        return () => undefined;
    const intervalMs = Math.max(MIN_INTERVAL_MS, deps.intervalMs ?? positiveIntEnv("PM_WATCH_INTERVAL_MS", DEFAULT_INTERVAL_MS));
    const onError = deps.onError ?? ((err) => console.error("Project watcher tick failed", err instanceof Error ? err.message : err));
    const { tick } = createProjectWatchCycle({ ...deps, intervalMs, onError });
    const timer = setInterval(() => { void tick().catch(onError); }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}
//# sourceMappingURL=project-watcher.js.map