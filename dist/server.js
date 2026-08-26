import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initSchema, assertDbConfigured, pool } from "./db.js";
import { createApp } from "./app.js";
import { projectsRoot } from "./services/pm-runner.js";
import { cleanupStaleClients } from "./services/sse.js";
import { startRealtimeBus } from "./services/realtime-bus.js";
import { startProjectWatcher } from "./services/project-watcher.js";
import { startMutationEventWatcher } from "./services/mutation-event-watcher.js";
import { assertOidcConfiguration } from "./oidc.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * Resolve this package's version from `package.json`, once at boot.
 *
 * Best-effort: returns `"unknown"` if the file is missing or fails to parse so
 * `/healthz` can always report a version string even in a broken checkout.
 */
function readPackageVersion() {
    try {
        const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
        return pkg.version ?? "unknown";
    }
    catch {
        return "unknown";
    }
}
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
}
catch (err) {
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
    const server = app.listen(PORT, (err) => {
        if (err) {
            console.error(`Failed to bind :${PORT}:`, err.message);
            process.exit(1);
        }
        console.log(`pm-web running on :${PORT}`);
    });
    server.on("error", (err) => {
        console.error(`Server error on :${PORT}:`, err.message);
        process.exit(1);
    });
    server.on("close", () => { stopProjectWatcher(); stopMutationEventWatcher(); void closeRealtimeBus(); });
    // Periodic cleanup of stale SSE clients
    setInterval(cleanupStaleClients, 5 * 60 * 1000);
})
    .catch((err) => {
    console.error("Failed to initialize pm-web runtime:", err instanceof Error ? err.message : err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map