/** Test-only preload: observe the actual production process through a private IPC channel. */
import { fanoutMeasurement, resetFanoutMeasurement } from "./capacity-fanout-probe.ts";
import { monitorEventLoopDelay } from "node:perf_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

let indexLocks = 0;
const originalOpen = fs.open;
// Successful lock payload writes count acquisitions, never retry attempts.
fs.open = async (...args: Parameters<typeof originalOpen>) => {
  const handle = await originalOpen(...args);
  if (path.basename(String(args[0])) === "history-event-index.lock") {
    const originalWrite = handle.writeFile.bind(handle);
    handle.writeFile = async (...parameters: Parameters<typeof originalWrite>) => {
      await originalWrite(...parameters);
      indexLocks += 1;
    };
  }
  return handle;
};
syncBuiltinESMExports();

const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
let previousCpu = process.cpuUsage();
let previousTime = performance.now();

/** Send process-only telemetry, excluding writer children and the load generator. */
function sample(): void {
  const now = performance.now();
  const cpu = process.cpuUsage();
  process.send?.({ capacity_probe: true, rss_bytes: process.memoryUsage().rss,
    cpu_core_percent: ((cpu.user - previousCpu.user) + (cpu.system - previousCpu.system)) / ((now - previousTime) * 10),
    event_loop_p99_ms: histogram.percentile(99) / 1e6, fanout: fanoutMeasurement() });
  previousCpu = cpu;
  previousTime = now;
}

const timer = setInterval(sample, 250);
timer.unref();
process.on("message", (message: unknown) => {
  if (message === "capacity-lock-count") {
    process.send?.({ capacity_lock_count: indexLocks, at: performance.now() });
  } else if (message === "capacity-reset") {
    histogram.reset();
    resetFanoutMeasurement();
    previousCpu = process.cpuUsage();
    previousTime = performance.now();
    process.send?.({ capacity_reset: true });
  } else if (message === "capacity-sample") sample();
});
process.on("disconnect", () => { clearInterval(timer); histogram.disable(); process.kill(process.pid, "SIGTERM"); });
