/** Reduce owned inspector captures to public-safe aggregate costs, without source URLs or identities. */
import { readFile, writeFile } from "node:fs/promises";
import type { Profiler, HeapProfiler } from "node:inspector";
import { isMainInvocation } from "./main-invocation.ts";

/** Retain only package-relative module names and public dependency names. */
function moduleName(url: string): string {
  for (const marker of ["/node_modules/", "/dist/", "/scripts/"]) {
    const index = url.lastIndexOf(marker);
    if (index >= 0) return url.slice(index + 1);
  }
  return url.startsWith("node:") ? url : "runtime";
}

/** Group repeated call sites by function/module so line-number changes do not hide comparisons. */
function callSite(frame: { functionName: string; url: string }): string {
  const name = /^[\w.$ ()<>:*+-]*$/.test(frame.functionName) ? frame.functionName : "anonymous";
  return `${moduleName(frame.url)}:${name || "anonymous"}`;
}

/** Attribute native writes/decodes through their retained stacks instead of guessing from a leaf name. */
function stackGroup(stack: readonly { functionName: string; url: string }[]): string {
  if (stack[0]?.functionName === "(idle)") return "idle";
  if (stack[0]?.functionName === "(garbage collector)") return "garbage_collection";
  if (stack.some((frame) => /\/node_modules\/(pg|pg-pool|pg-protocol)\//.test(frame.url))) return "postgres";
  if (stack.some((frame) => frame.url.endsWith("/dist/observability.js"))) return "logging";
  if (stack.some((frame) => frame.url.endsWith("/dist/services/sse-fanout.js"))) return stack.some((frame) => frame.functionName === "prepareFanout") ? "frame_preparation" : "fanout_service";
  if (stack.some((frame) => frame.url.endsWith("/dist/services/sse-access.js"))) return "authorization_service";
  if (stack.some((frame) => frame.url === "node:_http_outgoing")) return "http_output_callbacks";
  if (stack.some((frame) => /\/node_modules\/jsonwebtoken\//.test(frame.url))) return "session_verification";
  return "other";
}

/** Inspector allocation sizes are sampled estimates, including objects collected during the run. */
export function summarizeJoinProfile(cpu: Profiler.Profile, heap: HeapProfiler.SamplingHeapProfile) {
  const costs = new Map<string, number>();
  const nodes = new Map(cpu.nodes.map((node) => [node.id, node]));
  const parents = new Map(cpu.nodes.flatMap((node) => (node.children ?? []).map((id) => [id, node.id] as const)));
  const cpuGroups: Record<string, number> = {};
  cpu.samples?.forEach((id, index) => {
    const key = callSite(nodes.get(id)!.callFrame);
    const us = cpu.timeDeltas?.[index] ?? 0;
    costs.set(key, (costs.get(key) ?? 0) + us);
    const stack = [];
    let ancestor: number | undefined = id;
    while (ancestor !== undefined) { stack.push(nodes.get(ancestor)!.callFrame); ancestor = parents.get(ancestor); }
    const group = stackGroup(stack);
    cpuGroups[group] = (cpuGroups[group] ?? 0) + us / 1000;
  });
  const allocations = new Map<string, number>();
  const allocationGroups: Record<string, number> = {};
  /** Inclusive traversal counts each sampled object's allocation site exactly once. */
  function visit(node: HeapProfiler.SamplingHeapProfileNode, ancestors: HeapProfiler.SamplingHeapProfileNode["callFrame"][] = []): void {
    const key = callSite(node.callFrame);
    allocations.set(key, (allocations.get(key) ?? 0) + node.selfSize);
    const stack = [node.callFrame, ...ancestors];
    const group = stackGroup(stack);
    allocationGroups[group] = (allocationGroups[group] ?? 0) + node.selfSize;
    for (const child of node.children) visit(child, stack);
  }
  visit(heap.head);
  return { profile_wall_ms: (cpu.endTime - cpu.startTime) / 1000, cpu_samples: cpu.samples?.length ?? 0,
    sampled_allocation_bytes: [...allocations.values()].reduce((sum, bytes) => sum + bytes, 0),
    cpu_stack_sample_ms: cpuGroups, allocation_stack_sampled_bytes: allocationGroups,
    cpu_top: [...costs].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([site, us]) => ({ site, sample_ms: us / 1000 })),
    allocation_top: [...allocations].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([site, bytes]) => ({ site, sampled_bytes: bytes })) };
}

/** Raw profiles are read only from the caller's explicitly selected owned capture directory. */
async function main(): Promise<void> {
  const [directory, output] = process.argv.slice(2);
  if (!directory || !output) throw new Error("Supply the capture directory and aggregate output file");
  const cpu = JSON.parse(await readFile(`${directory}/cpu.cpuprofile`, "utf8")) as Profiler.Profile;
  const heap = JSON.parse(await readFile(`${directory}/allocation.heapprofile`, "utf8")) as HeapProfiler.SamplingHeapProfile;
  const sql = JSON.parse(await readFile(`${directory}/sql.json`, "utf8")) as unknown;
  await writeFile(output, JSON.stringify({ ...summarizeJoinProfile(cpu, heap), sql }, null, 2) + "\n", { flag: "wx" });
}
if (isMainInvocation(process.argv, import.meta.url)) await main();
