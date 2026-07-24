import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pool } from "../db.js";
import { getProjectDir } from "./pm-runner.js";
import {
  consumeSignaledMutation,
  deliverProjectEvent,
  getActiveProjectIds,
  wasSignaledWithin,
  type SSEEvent,
} from "./sse.js";

const DEFAULT_INTERVAL_MS = 2_000;
const MIN_INTERVAL_MS = 500;
// Item-type directories that hold user-facing `.toon` items:
const ITEM_DIRS = [
  "tasks", "issues", "epics", "features", "chores",
  "decisions", "meetings", "milestones", "reminders", "events",
];
const MAX_FILES_PER_PROJECT = 8_000; // safety cap on stat work per project per tick

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// FNV-1a (32-bit), computed over UTF-8 bytes via `Math.imul` — fast, no BigInt
// per byte and no allocation. Used to bind each file's path to its mtime so the
// aggregate fingerprint below can't be aliased by rearranging raw mtimes.
function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export async function computeWorkspaceSignature(dir: string): Promise<string> {
  // dir is a project root: <PROJECTS_ROOT>/<userId>/<slug>.
  // Detect out-of-band changes without recursive inotify or per-file memory.
  // A reduced max(mtime) alone misses (1) mtime-preserving restores (older
  // mtimes never advance the max) and (2) same-instant add/remove; a raw
  // count:max:sum(mtime) additionally *aliases* distinct states ({100,200,300}
  // and {150,150,300} share count/max/sum). So fingerprint each file by a hash
  // of its path bound to its mtime — h = fnv1a32("<subdir>/<name>:<mtimeMs>") —
  // and combine order-independently via XOR *and* sum. Rearranging mtimes across
  // paths changes each per-file hash, so the two aliasing states above now
  // differ. Computed in the same stat pass at zero extra I/O.
  const pmDir = path.join(dir, ".agents", "pm");
  let count = 0;
  let xorAcc = 0;
  let sumAcc = 0;
  let truncated = false;
  const scan = async (subdir: string, ext: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(path.join(pmDir, subdir), { withFileTypes: true });
    } catch {
      return; // ENOENT etc — subdir may not exist
    }
    for (const entry of entries) {
      if (count >= MAX_FILES_PER_PROJECT) { truncated = true; return; }
      if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
      try {
        const s = await stat(path.join(pmDir, subdir, entry.name));
        const h = fnv1a32(`${subdir}/${entry.name}:${Math.round(s.mtimeMs)}`);
        count += 1;
        xorAcc ^= h;
        sumAcc = (sumAcc + h) >>> 0; // wraps mod 2^32 — order-independent
      } catch {
        // file vanished between readdir and stat — ignore
      }
    }
  };
  for (const d of ITEM_DIRS) await scan(d, ".toon");
  await scan("history", ".jsonl");
  // `truncated` marks that a >MAX_FILES project was capped; changes to files
  // beyond the cap can still be missed (tracked as a follow-up: bounded
  // round-robin scan — pm-web-acwm). The common cases above are fully covered.
  return `${count}:${(xorAcc >>> 0)}:${sumAcc}${truncated ? ":T" : ""}`;
}

async function defaultResolveProjectDir(projectId: string): Promise<string | null> {
  // Do NOT swallow DB errors here: a transient `pool.query` failure must reach
  // the watcher's per-project try/catch (→ onError) so it is retried next tick.
  // Swallowing it would cache `null` for the whole active SSE session and
  // permanently stop watching this project. `null` is returned only when the
  // row is genuinely absent (safe to cache — avoids re-querying every tick).
  const res = await pool.query<{ user_id: string; slug: string }>(
    "SELECT user_id, slug FROM pm_projects WHERE id = $1",
    [projectId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return getProjectDir(row.user_id, row.slug);
}

export interface ProjectWatcherDeps {
  intervalMs?: number;
  suppressWindowMs?: number;
  getActiveProjectIds?: () => string[];
  resolveProjectDir?: (projectId: string) => Promise<string | null>;
  readSignature?: (projectDir: string) => Promise<string>;
  wasSignaledWithin?: (projectId: string, windowMs: number) => boolean;
  consumeSignal?: (projectId: string) => void;
  emit?: (projectId: string, event: SSEEvent) => void;
  onError?: (err: unknown) => void;
}

// Pure, testable cycle. Holds per-project baseline state across ticks.
export function createProjectWatchCycle(deps: ProjectWatcherDeps = {}): {
  tick: () => Promise<void>;
  suppressWindowMs: number;
} {
  const intervalMs = Math.max(MIN_INTERVAL_MS, deps.intervalMs ?? positiveIntEnv("PM_WATCH_INTERVAL_MS", DEFAULT_INTERVAL_MS));
  const suppressWindowMs = deps.suppressWindowMs ?? intervalMs * 2 + 3_000;
  const getIds = deps.getActiveProjectIds ?? getActiveProjectIds;
  const resolveDir = deps.resolveProjectDir ?? defaultResolveProjectDir;
  const readSig = deps.readSignature ?? computeWorkspaceSignature;
  const signaled = deps.wasSignaledWithin ?? wasSignaledWithin;
  const consumeSignal = deps.consumeSignal ?? consumeSignaledMutation;
  const emit = deps.emit ?? deliverProjectEvent;
  const onError = deps.onError ?? (() => undefined);

  const lastSeen = new Map<string, string>();
  const dirCache = new Map<string, string | null>();
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return; // never overlap ticks
    inFlight = true;
    try {
      const ids = getIds();
      const active = new Set(ids);
      for (const id of [...lastSeen.keys()]) if (!active.has(id)) lastSeen.delete(id);
      for (const id of [...dirCache.keys()]) if (!active.has(id)) dirCache.delete(id);
      for (const projectId of ids) {
        try {
          let dir = dirCache.get(projectId);
          if (dir === undefined) {
            dir = await resolveDir(projectId);
            dirCache.set(projectId, dir);
          }
          if (!dir) continue;
          const sig = await readSig(dir);
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
            } else {
              emit(projectId, { type: "workspace-changed", data: { source: "filesystem" } });
            }
          }
        } catch (err) {
          onError(err);
        }
      }
    } finally {
      inFlight = false;
    }
  };

  return { tick, suppressWindowMs };
}

export function startProjectWatcher(deps: ProjectWatcherDeps = {}): () => void {
  if (process.env.PM_WATCH_PROJECTS === "false") return () => undefined;
  const intervalMs = Math.max(MIN_INTERVAL_MS, deps.intervalMs ?? positiveIntEnv("PM_WATCH_INTERVAL_MS", DEFAULT_INTERVAL_MS));
  const onError = deps.onError ?? ((err: unknown) => console.error("Project watcher tick failed", err instanceof Error ? err.message : err));
  const { tick } = createProjectWatchCycle({ ...deps, intervalMs, onError });
  const timer = setInterval(() => { void tick().catch(onError); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}