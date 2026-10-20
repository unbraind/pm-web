/** Run the shipped extension in a separate process so exit codes are observable. */
import { isHostOutputSuppressed } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../../dist/index.js";

const host = await createExtensionTestHarness(extension, { name: "pm-web", capabilities: ["commands", "schema"] });
try {
  const result = await host.runCommand({
    command: process.argv[2], options: JSON.parse(process.argv[3]) as Record<string, unknown>,
    global: { json: true }, pmRoot: process.env.TEST_PM_ROOT,
  });
  if (!isHostOutputSuppressed(result.result)) console.log(JSON.stringify(result.result));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
} finally {
  await host.deactivate();
}
