import { logEvent, logError } from "./observability.js";
import { realtimeHealth } from "./services/realtime-observability.js";
import { initSchema, assertDbConfigured, pool } from "./db.js";
import { createApp, readPackageVersion } from "./app.js";
import { projectsRoot } from "./services/pm-runner.js";
import { cleanupStaleClients, closeAllSSEClients } from "./services/sse.js";
import { startRealtimeBus } from "./services/realtime-bus.js";
import { startProjectWatcher } from "./services/project-watcher.js";
import { startMutationEventWatcher } from "./services/mutation-event-watcher.js";
import { assertOidcConfiguration } from "./oidc.js";
/** Preserve fatal semantics while emitting privacy-safe structured diagnostics. */
function fatalError(error) {
    logError("unhandled_error", error);
    process.exit(1);
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
// Validate configuration before doing anything that needs the database, so a
// missing DATABASE_URL fails fast with a clear message instead of hanging on a
// DNS/connection timeout.
try {
    assertDbConfigured();
    assertOidcConfiguration();
}
catch (err) {
    logError("configuration_error", err);
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
    const server = app.listen(PORT, (err) => {
        if (err) {
            logError("bind_error", err);
            process.exit(1);
        }
        const address = server.address();
        logEvent("server_started", { port: typeof address === "object" && address ? address.port : PORT });
    });
    server.on("error", (err) => {
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
    const shutdown = () => {
        closeAllSSEClients();
        server.close();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
})
    .catch((err) => {
    logError("initialization_error", err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map