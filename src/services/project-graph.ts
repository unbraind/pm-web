import { readFile } from "node:fs/promises";
import path from "node:path";
import { graphFromItems, type Graph } from "pm-graph";
import { getProjectDir, readCompletePmItems, readPmSettings } from "./pm-runner.ts";

/** The complete pm-graph export with an additive web provenance indicator. */
export type ProjectGraph = Graph & { source: "pm-graph" | "pm-web" };

/**
 * Read the complete project graph without invoking extension hooks or commands.
 * Both installed and built-in reads use the exact-pinned public pm-graph pure
 * builder, retaining every export field and the builder's insertion ordering.
 * A readable project-local pm-graph manifest plus enabled configuration selects
 * the installed export model; it says nothing about Neo4j availability. No project code runs.
 * Invalid or absent manifests select the same builder as a built-in read.
 * Uncertified item reads fail instead of returning a partial graph.
 */
export async function readProjectGraph(
  ownerUserId: string,
  slug: string,
): Promise<{ graph: ProjectGraph; extensionAvailable: boolean }> {
  const itemsResult = await readCompletePmItems(ownerUserId, slug, false, true, true);
  if (!itemsResult.ok) throw new Error(itemsResult.stderr || "Failed to load items for graph");
  const workspace = path.resolve(getProjectDir(ownerUserId, slug));
  let extensionAvailable = false;
  try {
    const manifest: unknown = JSON.parse(await readFile(
      path.join(workspace, ".agents", "pm", "extensions", "pm-graph", "manifest.json"), "utf8",
    ));
    const settings = readPmSettings(ownerUserId, slug) as {
      extensions?: { enabled?: string[]; disabled?: string[] };
    };
    const enabled = settings.extensions?.enabled ?? [];
    const disabled = settings.extensions?.disabled ?? [];
    extensionAvailable = Array.isArray(enabled) && Array.isArray(disabled)
      && !disabled.includes("pm-graph") && (enabled.length === 0 || enabled.includes("pm-graph"))
      && manifest !== null && typeof manifest === "object"
      && "name" in manifest && manifest.name === "pm-graph"
      && "entry" in manifest && typeof manifest.entry === "string";
  } catch {
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
