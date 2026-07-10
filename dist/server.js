import { initSchema, assertDbConfigured } from "./db.js";
import { createApp } from "./app.js";
import { cleanupStaleClients } from "./services/sse.js";
const PORT = parseInt(process.env.PORT || "4000", 10);
const app = createApp();
// Validate configuration before doing anything that needs the database, so a
// missing DATABASE_URL fails fast with a clear message instead of hanging on a
// DNS/connection timeout.
try {
    assertDbConfigured();
}
catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
}
// Init DB schema, then start server
initSchema()
    .then(() => {
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
    // Periodic cleanup of stale SSE clients
    setInterval(cleanupStaleClients, 5 * 60 * 1000);
})
    .catch((err) => {
    console.error("Failed to initialize database schema:", err instanceof Error ? err.message : err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map