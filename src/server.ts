import "./server-preflight.ts";
import { logEvent, logError } from "./observability.ts";
import { realtimeHealth } from "./services/realtime-observability.ts";
import { initSchema, pool } from "./db.ts";
import { createApp, readPackageVersion } from "./app.ts";
import { projectsRoot } from "./services/pm-runner.ts";
import { cleanupStaleClients, closeAllSSEClients } from "./services/sse.ts";
import { startRealtimeBus } from "./services/realtime-bus.ts";
import { startProjectWatcher } from "./services/project-watcher.ts";
import { startMutationEventWatcher } from "./services/mutation-event-watcher.ts";

/** Preserve fatal semantics while emitting privacy-safe structured diagnostics. */
function fatalError(error: unknown): void {
  logError("unhandled_error", error);
  // A piped stdout write may still be queued. Exit only after earlier writes finish.
  process.stdout.write("", () => process.exit(1));
}
process.once("uncaughtException", fatalError);
process.once("unhandledRejection", fatalError);

const PORT = parseInt(process.env.PORT || "4000", 10);

// Wire the real `/healthz` probing handler with the production dependencies:
// the shared PostgreSQL pool (probed with `SELECT 1`) and the host-mounted
// projects root (probed for writability). Supplying these here is what makes
// the deployed service report 503 during a Postgres or projects-volume outage
// instead of the unconditional `ok:true` the route used to return.
const app = createApp({
  health: {
    pool,
    realtime: realtimeHealth,
    projectsRoot: projectsRoot(),
    version: readPackageVersion(),
  },
});

// Init DB schema, then start server
initSchema()
  .then(async () => {
    const closeRealtimeBus = await startRealtimeBus();
    const stopProjectWatcher = startProjectWatcher();
    const stopMutationEventWatcher = startMutationEventWatcher();
    // Express 5 invokes the listen callback WITH the error (it is installed
    // as the server's 'error' handler), so ignoring the argument turns
    // EADDRINUSE into a false "running" message and a process that idles
    // forever without owning the port.
    const server = app.listen(PORT, (err?: Error) => {
      if (err) {
        logError("bind_error", err);
        process.exit(1);
      }
      const address = server.address();
      if (process.send && typeof address === "object" && address) process.send({ type: "pm-web-listening", port: address.port });
      logEvent("server_started", { port: typeof address === "object" && address ? address.port : PORT });
    });
    server.on("error", (err: Error) => {
      logError("server_error", err);
      process.exit(1);
    });
    // Periodic cleanup of stale SSE clients
    const staleClientTimer = setInterval(cleanupStaleClients, 5 * 60 * 1000);
    server.on("close", () => {
      clearInterval(staleClientTimer);
      stopProjectWatcher();
      stopMutationEventWatcher();
      void closeRealtimeBus()
        .finally(() => pool.end())
        .finally(() => process.exit(0));
    });
    /** End streaming responses before waiting for the HTTP server to close. */
    const shutdown = (): void => {
      closeAllSSEClients();
      server.close();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  })
  .catch((err) => {
    process.stderr.write("PostgreSQL initialization failed. Check DATABASE_URL or POSTGRES_* settings, database reachability and CREATE/ALTER permissions. Connection details redacted.\n");
    logError("initialization_error", err);
    process.exit(1);
  });
