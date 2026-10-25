import { assertInitializedTracker } from "@unbrained/pm-cli/sdk";
/** Admit only an explicitly selected, readable SDK tracker; keep diagnostics private. */
export async function workspaceInitialized(pmRoot) {
    if (!pmRoot)
        return false;
    try {
        await assertInitializedTracker(pmRoot);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=tracker-preflight.js.map