// pm-web — Extension wrapper for the pm-web server
// This file registers the web server as a pm extension command.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Inline defineExtension helper (avoids runtime dependency on @unbrained/pm-cli/sdk)
function defineExtension(m) { return m; }
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let serverProcess = null;
export default defineExtension({
    name: "pm-web",
    version: "1.0.0",
    activate(api) {
        // -----------------------------------------------------------------------
        // Command: pm web [--port <port>]
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "web",
            description: "Start the pm-web server. Opens a browser-based UI for managing pm projects.",
            intent: "launch the pm-web server",
            examples: [
                "pm web",
                "pm web --port 8080",
            ],
            flags: [
                { long: "--port", value_name: "port", description: "Port to listen on (default: 4000 or PORT env var)" },
                { long: "--detach", description: "Run the server in the background" },
            ],
            async run(ctx) {
                const port = ctx.options["port"] ?? process.env["PORT"] ?? "4000";
                const detach = Boolean(ctx.options["detach"]);
                const serverPath = path.resolve(__dirname, "server.js");
                if (detach) {
                    if (serverProcess) {
                        console.error(`pm-web is already running (PID ${serverProcess.pid})`);
                        return { status: "already_running", pid: serverProcess.pid };
                    }
                    serverProcess = spawn("node", [serverPath], {
                        env: { ...process.env, PORT: String(port) },
                        detached: true,
                        stdio: "ignore",
                    });
                    serverProcess.unref();
                    console.error(`pm-web started on port ${port} (PID ${serverProcess.pid})`);
                    return { status: "started", port: Number(port), pid: serverProcess.pid };
                }
                // Foreground mode — the server takes over the process
                console.error(`Starting pm-web on port ${port}…`);
                console.error("Press Ctrl+C to stop.\n");
                const child = spawn("node", [serverPath], {
                    env: { ...process.env, PORT: String(port) },
                    stdio: "inherit",
                });
                child.on("exit", (code) => {
                    console.error(`pm-web exited with code ${code}`);
                });
                return { status: "started", port: Number(port) };
            },
        });
    },
});
//# sourceMappingURL=index.js.map