/** Exercise the doctor's human output using the built extension and real database. */
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../../dist/index.js";
const host = await createExtensionTestHarness(extension, { name: "pm-web", capabilities: ["commands", "schema"] });
try { await host.runCommand({ command: "web doctor", options: { port: process.env.PORT }, global: { json: false } }); }
finally { await host.deactivate(); }
