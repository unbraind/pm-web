import { type Graph } from "pm-graph";
/** The complete pm-graph export with an additive web provenance indicator. */
export type ProjectGraph = Graph & {
    source: "pm-graph" | "pm-web";
};
/**
 * Read the complete project graph without invoking extension hooks or commands.
 * Both installed and built-in reads use the exact-pinned public pm-graph pure
 * builder, retaining every export field and the builder's insertion ordering.
 * A readable project-local pm-graph manifest indicates installation only; it
 * says nothing about activation or Neo4j availability. No project code runs.
 * Invalid or absent manifests select the same builder as a built-in read.
 * Uncertified item reads fail instead of returning a partial graph.
 */
export declare function readProjectGraph(ownerUserId: string, slug: string): Promise<{
    graph: ProjectGraph;
    extensionAvailable: boolean;
}>;
