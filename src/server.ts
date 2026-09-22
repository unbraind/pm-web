import { initSchema, assertDbConfigured, pool } from "./db.ts";
import { createApp, readPackageVersion } from "./app.ts";
import { projectsRoot } from "./services/pm-runner.ts";
import { cleanupStaleClients, closeAllSSEClients } from "./services/sse.ts";
import { startRealtimeBus } from "./services/realtime-bus.ts";
import { startProjectWatcher } from "./services/project-watcher.ts";
import { startMutationEventWatcher } from "./services/mutation-event-watcher.ts";
import { assertOidcConfiguration } from "./oidc.ts";

const PORT = parseInt(process.env.PORT || "4000", 10);

// Wire the real `/healthz` probing handler with the production dependencies:
// the shared PostgreSQL pool (probed with `SELECT 1`) and the host-mounted
// projects root (probed for writability). Supplying these here is what makes
// the deployed service report 503 during a Postgres or projects-volume outage
// instead of the unconditional `ok:true` the route used to return.
const app = createApp({
  health: {
    pool,
    projectsRoot: projectsRoot(),
    version: readPackageVersion(),
  },
});

// Validate configuration before doing anything that needs the database, so a
// missing DATABASE_URL fails fast with a clear message instead of hanging on a
// DNS/connection timeout.
try {
  assertDbConfigured();
  assertOidcConfiguration();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

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
        console.error(`Failed to bind :${PORT}:`, err.message);
        process.exit(1);
      }
      console.log(`pm-web running on :${PORT}`);
    });
    server.on("error", (err: Error) => {
      console.error(`Server error on :${PORT}:`, err.message);
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
    console.error("Failed to initialize pm-web runtime:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
