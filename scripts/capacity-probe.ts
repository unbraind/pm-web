/** Test-only preload: observe the actual production process through a private IPC channel. */
import { monitorEventLoopDelay } from "node:perf_hooks";

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
    event_loop_p99_ms: histogram.percentile(99) / 1e6 });
  previousCpu = cpu;
  previousTime = now;
}

const timer = setInterval(sample, 250);
timer.unref();
process.on("message", (message: unknown) => {
  if (message === "capacity-reset") {
    histogram.reset();
    previousCpu = process.cpuUsage();
    previousTime = performance.now();
    process.send?.({ capacity_reset: true });
  } else if (message === "capacity-sample") sample();
});
process.on("disconnect", () => { clearInterval(timer); histogram.disable(); process.kill(process.pid, "SIGTERM"); });
