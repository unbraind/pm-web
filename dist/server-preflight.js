import { startupConfigIssues } from "./startup-config.js";
// This module must be the first server import: auth and database modules read
// configuration during evaluation. Emit only diagnostics built from names.
const issues = startupConfigIssues();
if (issues.length) {
    const message = issues.join("\n");
    process.stderr.write(`pm-web startup preflight failed:\n${message}\n`);
    process.stdout.write(`${JSON.stringify({ event: "configuration_error", message })}\n`);
    process.exit(1);
}
//# sourceMappingURL=server-preflight.js.map