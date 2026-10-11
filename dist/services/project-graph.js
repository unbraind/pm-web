import { readFile } from "node:fs/promises";
import path from "node:path";
import { graphFromItems } from "pm-graph";
import { getProjectDir, readCompletePmItems } from "./pm-runner.js";
/**
 * Read the complete project graph without invoking extension hooks or commands.
 * Both installed and built-in reads use the exact-pinned public pm-graph pure
 * builder, retaining every export field and the builder's insertion ordering.
 * A readable project-local pm-graph manifest indicates installation only; it
 * says nothing about activation or Neo4j availability. No project code runs.
 * Invalid or absent manifests select the same builder as a built-in read.
 * Uncertified item reads fail instead of returning a partial graph.
 */
export async function readProjectGraph(ownerUserId, slug) {
    const itemsResult = await readCompletePmItems(ownerUserId, slug, false, true, true);
    if (!itemsResult.ok)
        throw new Error(itemsResult.stderr || "Failed to load items for graph");
    const workspace = path.resolve(getProjectDir(ownerUserId, slug));
    let extensionAvailable = false;
    try {
        const manifest = JSON.parse(await readFile(path.join(workspace, ".agents", "pm", "extensions", "pm-graph", "manifest.json"), "utf8"));
        extensionAvailable = manifest !== null && typeof manifest === "object"
            && "name" in manifest && manifest.name === "pm-graph"
            && "entry" in manifest && typeof manifest.entry === "string";
    }
    catch {
        // Manifest inspection is optional and never loads project extension code.
    }
    return {
        graph: {
            ...graphFromItems(itemsResult.result.items, workspace, new Map()),
            source: extensionAvailable ? "pm-graph" : "pm-web",
        },
        extensionAvailable,
    };
}
//# sourceMappingURL=project-graph.js.map