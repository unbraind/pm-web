import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolveProjectDir } from "./pm-runner.js";
import { consumeSignaledMutation, deliverProjectEvent, getActiveProjectIds, wasSignaledWithin, } from "./sse.js";
// Safety-net filesystem sweep. The mutation-event stream
// (src/services/mutation-event-watcher.ts) is now the PRIMARY out-of-band change
// detector; this poll only catches raw non-pm writes that bypass the committed
// history (git merge, rsync restore, manual edits). Slower default cadence keeps
// per-tick stat I/O low since the primary path covers committed mutations at
// ~250ms latency.
const DEFAULT_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 500;
// Item-type directories that hold user-facing `.toon` items:
const ITEM_DIRS = [
    "tasks", "issues", "epics", "features", "chores",
    "decisions", "meetings", "milestones", "reminders", "events",
];
// Default cap on `stat` calls per project per tick. Projects with more eligible
// files are swept round-robin across ticks so I/O stays bounded (see
// stepWorkspaceSweep); overridable via PM_WATCH_MAX_FILES_PER_TICK.
const DEFAULT_MAX_FILES_PER_TICK = 8_000;
function positiveIntEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
// FNV-1a (32-bit), computed over UTF-8 bytes via `Math.imul` — fast, no BigInt
// per byte and no allocation. Used to bind each file's path to its mtime so the
// aggregate fingerprint below can't be aliased by rearranging raw mtimes.
function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
// A file's fingerprint contribution — its path bound to its mtime. Combined
// order-independently via XOR *and* sum so rearranging mtimes across paths still
// changes the aggregate (defeats the count:max:sum aliasing described below).
function fileFingerprint(subdir, name, mtimeMs) {
    return fnv1a32(`${subdir}/${name}:${Math.round(mtimeMs)}`);
}
// Enumerate every eligible `.toon`/`.jsonl` item file in a stable, deterministic
// order (ITEM_DIRS order, then history; names sorted within each dir). This is
// cheap regardless of project size: one `readdir` syscall per subdir, names
// only — it performs NO `stat` calls. The expensive per-file `stat` work is what
// the round-robin sweep below bounds per tick.
async function enumerateEligibleFiles(pmDir) {
    const files = [];
    const collect = async (subdir, ext) => {
        let entries;
        try {
            entries = await readdir(path.join(pmDir, subdir), { withFileTypes: true });
        }
        catch {
            return; // ENOENT etc — subdir may not exist
        }
        const names = entries
            .filter((e) => e.isFile() && e.name.endsWith(ext))
            .map((e) => e.name)
            .sort();
        for (const name of names)
            files.push({ subdir, name });
    };
    for (const d of ITEM_DIRS)
        await collect(d, ".toon");
    await collect("history", ".jsonl");
    return files;
}
export async function computeWorkspaceSignature(dir) {
    // dir is a project root: <PROJECTS_ROOT>/<userId>/<slug>.
    // Detect out-of-band changes without recursive inotify or per-file memory.
    // A reduced max(mtime) alone misses (1) mtime-preserving restores (older
    // mtimes never advance the max) and (2) same-instant add/remove; a raw
    // count:max:sum(mtime) additionally *aliases* distinct states ({100,200,300}
    // and {150,150,300} share count/max/sum). So fingerprint each file by a hash
    // of its path bound to its mtime and combine order-independently via XOR *and*
    // sum. One-shot: stats every eligible file. `stepWorkspaceSweep` is the
    // bounded, tick-spread variant used by the live watcher.
    const pmDir = path.join(dir, ".agents", "pm");
    const files = await enumerateEligibleFiles(pmDir);
    let count = 0;
    let xorAcc = 0;
    let sumAcc = 0;
    for (const f of files) {
        try {
            const s = await stat(path.join(pmDir, f.subdir, f.name));
            const h = fileFingerprint(f.subdir, f.name, s.mtimeMs);
            count += 1;
            xorAcc ^= h;
            sumAcc = (sumAcc + h) >>> 0; // wraps mod 2^32 — order-independent
        }
        catch {
            // file vanished between readdir and stat — ignore
        }
    }
    return `${count}:${xorAcc >>> 0}:${sumAcc}`;
}
export function newSweepState() {
    return { cursor: 0, count: 0, xor: 0, sum: 0 };
}
export async function stepWorkspaceSweep(dir, state, maxFilesPerTick) {
    const pmDir = path.join(dir, ".agents", "pm");
    const files = await enumerateEligibleFiles(pmDir);
    const total = files.length;
    const end = Math.min(state.cursor + maxFilesPerTick, total);
    for (let i = state.cursor; i < end; i += 1) {
        const f = files[i];
        try {
            const s = await stat(path.join(pmDir, f.subdir, f.name));
            const h = fileFingerprint(f.subdir, f.name, s.mtimeMs);
            state.count += 1;
            state.xor ^= h;
            state.sum = (state.sum + h) >>> 0;
        }
        catch {
            // file vanished between readdir and stat — ignore
        }
    }
    state.cursor = end;
    // Sweep completes once the cursor reaches the current file count (also when a
    // shrink moved `total` at or below the cursor). Small projects (<= cap files)
    // finish in a single tick — identical to the one-shot signature, no latency.
    if (state.cursor >= total) {
        return { completed: true, signature: `${state.count}:${state.xor >>> 0}:${state.sum}` };
    }
    return { completed: false };
}
// Pure, testable cycle. Holds per-project baseline state across ticks.
export function createProjectWatchCycle(deps = {}) {
    const intervalMs = Math.max(MIN_INTERVAL_MS, deps.intervalMs ?? positiveIntEnv("PM_WATCH_INTERVAL_MS", DEFAULT_INTERVAL_MS));
    const suppressWindowMs = deps.suppressWindowMs ?? intervalMs * 2 + 3_000;
    const maxFilesPerTick = Math.max(1, deps.maxFilesPerTick ?? DEFAULT_MAX_FILES_PER_TICK);
    const getIds = deps.getActiveProjectIds ?? getActiveProjectIds;
    const resolveDir = deps.resolveProjectDir ?? resolveProjectDir;
    const signaled = deps.wasSignaledWithin ?? wasSignaledWithin;
    const consumeSignal = deps.consumeSignal ?? consumeSignaledMutation;
    const emit = deps.emit ?? deliverProjectEvent;
    const onError = deps.onError ?? (() => undefined);
    // A caller-supplied one-shot `readSignature` is adapted into a sweep that
    // completes on the first tick, so legacy callers/tests keep exact semantics.
    const legacyReadSig = deps.readSignature;
    const stepSig = legacyReadSig
        ? async (dir) => ({
            completed: true,
            signature: await legacyReadSig(dir),
        })
        : deps.stepSignature ?? stepWorkspaceSweep;
    const lastSeen = new Map();
    const dirCache = new Map();
    const sweeps = new Map();
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
            for (const id of [...sweeps.keys()])
                if (!active.has(id))
                    sweeps.delete(id);
            for (const projectId of ids) {
                try {
                    let dir = dirCache.get(projectId);
                    if (dir === undefined) {
                        dir = await resolveDir(projectId);
                        dirCache.set(projectId, dir);
                    }
                    if (!dir)
                        continue;
                    let state = sweeps.get(projectId);
                    if (!state) {
                        state = newSweepState();
                        sweeps.set(projectId, state);
                    }
                    const { completed, signature } = await stepSig(dir, state, maxFilesPerTick);
                    if (!completed || signature === undefined)
                        continue; // mid-sweep — resume next tick
                    sweeps.set(projectId, newSweepState()); // reset for the next sweep
                    const sig = signature;
                    const prev = lastSeen.get(projectId);
                    if (prev === undefined) {
                        lastSeen.set(projectId, sig); // baseline — never emit on first observation
                        continue;
                    }
                    if (sig !== prev) {
                        lastSeen.set(projectId, sig);
                        if (signaled(projectId, suppressWindowMs)) {
                            // Attribute this one delta to the signaled write and consume the
                            // signal, so a *later* unrelated direct edit in the same window is
                            // no longer swallowed — it will find no signal and emit.
                            consumeSignal(projectId);
                        }
                        else {
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
    const maxFilesPerTick = deps.maxFilesPerTick ?? positiveIntEnv("PM_WATCH_MAX_FILES_PER_TICK", DEFAULT_MAX_FILES_PER_TICK);
    const onError = deps.onError ?? ((err) => console.error("Project watcher tick failed", err instanceof Error ? err.message : err));
    const { tick } = createProjectWatchCycle({ ...deps, intervalMs, maxFilesPerTick, onError });
    const timer = setInterval(() => { void tick().catch(onError); }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}
//# sourceMappingURL=project-watcher.js.map