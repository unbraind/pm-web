/** Exercise the adopted SDK paths with no executable Git available. */
import assert from "node:assert/strict";
import { configureLocalOllamaSearch, projectExists } from "../../src/services/pm-runner.ts";
import { workspaceInitialized } from "../../src/tracker-preflight.ts";
import path from "node:path";

const root = process.argv[2];
process.env.PROJECTS_ROOT = path.dirname(path.dirname(root));
await configureLocalOllamaSearch(root);
assert.equal(await workspaceInitialized(path.join(root, ".agents", "pm")), true);
assert.equal(await projectExists(path.basename(path.dirname(root)), path.basename(root)), true);
