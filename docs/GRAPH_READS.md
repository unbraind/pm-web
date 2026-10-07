# Observational graph export fidelity

`GET /api/projects/:projectId/pm/graph` and its implicit `HEAD` read certified
complete PM metadata with `noExtensions: true`. They never provision, activate
or execute project extensions. Both the installed and built-in paths use the
public pure `graphFromItems` API from exact-pinned `pm-graph` 2026.10.5. Explicit
POST synchronization remains protected by edit permission and CSRF checks.

The graph retains the default extension export's `workspace`, `projectKey`,
`generatedAt`, ordered `nodes` and ordered `relationships`. Labels, types,
properties, nested dependency attributes and provenance are preserved without
renaming or filtering. The web response adds `source`. This contract covers
the full default export, including terminal items and external references;
the overview does not apply the extension CLI's optional shaping flags.

The certified list uses display ordering. A second public SDK metadata read
supplies the export's native storage order; each identifier must match exactly
one certified row or the request fails. The builder uses the certified rows,
never the second reader's uncertified payload. There are no per-item commands.
The SDK can refresh reconstructible `runtime/metadata-cache*` files on reads;
item content, history, settings, schema and extension files remain unchanged.
The SDK currently has no certified source-order or cache-free read option.

`extensionAvailable` means a project-local pm-graph manifest with the expected
name and an entry string was observed. It does not imply activation, entry
execution, Neo4j credentials or database connectivity. When true, `source` is
`pm-graph`; absent, unreadable or malformed manifests select `source: pm-web`.
Both use the same pinned builder. An older or customized project extension
does not override the web builder; version parity is measured against the
pinned published version. The UI labels installation as `pm-graph` rather than
inferring that Neo4j is available.

`GET /pm/graph/neighbors/:nodeId` uses the same read model. It preserves the
original node `id`, `labels` and `properties` and each relationship's `from`,
`to`, `type` and `properties`, in export order. It adds relationship `direction`
and keeps the node's flattened properties and `_labels` for compatibility.
The response includes the same `source` and installation indicator, including
when the requested node is absent.

`test/graph-export-fidelity.test.ts` compares real installed extension CLI
exports with JSON round trips of the web model on 20 reproducible generated
trackers, including empty graphs, mixed item types and lifecycle states,
cycles, external targets, facets, duplicate edges, custom edge types and nested
provenance. Every export field and array position must agree. Independent reads
have their own valid `generatedAt` timestamps; only that timestamp and the
additive `source` are excluded from equality. A real PostgreSQL and built-package
HTTP test covers view-only GET/HEAD, neighbors, access denial and unchanged
tracker state, with a project entry that would write and throw if executed.

A separate 2,000-item synthetic tracker must return every item in under ten
seconds, excluding fixture construction. This is a bounded regression budget,
not a production capacity or hosted readiness claim. No private hosted data
is used. Run the graph checks after `npm run build`:

```sh
node scripts/with-test-db.ts node --test test/graph-export-fidelity.test.ts test/graph-read-only.test.ts
```

The implementation and verification evidence are linked from
[pm-web-38n5](../.agents/pm/features/pm-web-38n5.toon).
