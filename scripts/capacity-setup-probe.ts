/** Test-only setup control isolates established fan-out from incremental roster join storms. */
import { registerHooks } from "node:module";
import { parse } from "@babel/parser";

const pending = new Map<string, () => void>();
let released = false;
const symbol = Symbol.for("pm-web.capacity.setup");

/** Add one checked warm-up interception without modifying authorization, sockets or measured delivery. */
export function instrumentCapacitySetup(source: string): string {
  const parsed = parse(source, { sourceType: "module" });
  for (const node of parsed.program.body) {
    const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;
    if (declaration?.type !== "FunctionDeclaration" || declaration.id?.name !== "schedulePresence") continue;
    const at = declaration.body.start! + 1;
    return source.slice(0, at) + '\nif (globalThis[Symbol.for("pm-web.capacity.setup")].hold(projectId, () => broadcastPresence(projectId))) return;\n' + source.slice(at);
  }
  throw new Error("Capacity setup probe source drift");
}

if (process.env.PM_WEB_CAPACITY_QUIET_SETUP === "1") {
  Reflect.set(globalThis, symbol, {
    /** Retain the latest real roster callback per project until all authenticated sockets exist. */
    hold: (projectId: string, broadcast: () => void): boolean => {
      if (released) return false;
      pending.set(projectId, broadcast);
      return true;
    },
  });
  registerHooks({
    load(url, options, nextLoad) {
      const loaded = nextLoad(url, options);
      if (!url.endsWith("/dist/services/sse.js") || !loaded.source) return loaded;
      const source = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
      return { ...loaded, source: instrumentCapacitySetup(source) };
    },
  });
  process.on("message", (message: unknown) => {
    if (message !== "capacity-setup-release") return;
    released = true;
    for (const broadcast of pending.values()) broadcast();
    pending.clear();
    process.send?.({ capacity_setup_released: true });
  });
}
