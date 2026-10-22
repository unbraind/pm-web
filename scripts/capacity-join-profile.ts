/** Opt-in test-child CPU, allocation and SQL attribution; raw profiles stay outside the repository. */
import { Session } from "node:inspector/promises";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

interface SqlCost { calls: number; rows: number; elapsed_ms: number; failures: number }
const sql: Record<string, SqlCost> = {};
const original = pg.Client.prototype.query;

/** Classify fixed package queries without retaining SQL, parameters or identities. */
function category(text: unknown): string {
  if (typeof text !== "string") return "other";
  if (text.includes("UNION SELECT shared_with_user_id")) return "fanout_authorization";
  if (text.includes("SELECT u.display_name FROM pm_users u")) return "join_access_profile";
  if (text.includes("SELECT display_name FROM pm_users")) return "join_profile";
  if (text.includes("FROM pm_projects WHERE id = $1 AND user_id = $2")) return "join_ownership";
  if (text.includes("JOIN pm_project_shares ps ON ps.project_id = p.id")) return "shared_access";
  return "other";
}

// Pool queries use the callback overload on the borrowed client. Preserve that
// overload, its return value and receiver rather than changing transport timing.
pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
  const last = args.at(-1);
  if (typeof last !== "function") return Reflect.apply(original, this, args);
  const cost = sql[category(args[0])] ??= { calls: 0, rows: 0, elapsed_ms: 0, failures: 0 };
  cost.calls += 1;
  const started = performance.now();
  args[args.length - 1] = function (this: unknown, ...values: unknown[]) {
    cost.elapsed_ms += performance.now() - started;
    if (values[0]) cost.failures += 1;
    const result = values[1];
    if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) cost.rows += result.rows.length;
    return Reflect.apply(last, this, values);
  };
  return Reflect.apply(original, this, args);
} as typeof original;

const directory = process.env.PM_WEB_CAPACITY_PROFILE_DIR;
const session = new Session();
if (!directory) throw new Error("Join profiling requires an owned output directory");
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.start");
await session.post("HeapProfiler.startSampling", { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });

/** Stop sampling before writing artifacts and acknowledge only complete captures. */
async function capture(): Promise<void> {
  const { profile: cpu } = await session.post("Profiler.stop");
  const { profile: heap } = await session.post("HeapProfiler.stopSampling");
  await Promise.all([
    writeFile(path.join(directory!, "cpu.cpuprofile"), JSON.stringify(cpu), { flag: "wx" }),
    writeFile(path.join(directory!, "allocation.heapprofile"), JSON.stringify(heap), { flag: "wx" }),
    writeFile(path.join(directory!, "sql.json"), JSON.stringify(sql), { flag: "wx" }),
  ]);
  session.disconnect();
  process.send?.({ capacity_join_profile: true });
}
process.on("message", (message: unknown) => {
  if (message === "capacity-join-profile-stop") void capture().catch(() => process.send?.({ capacity_join_profile: false }));
});
