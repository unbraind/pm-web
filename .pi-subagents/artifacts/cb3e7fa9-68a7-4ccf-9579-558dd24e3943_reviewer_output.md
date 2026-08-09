I have completed a full accuracy audit of every `/** */` docstring in both files against its function body. Here is my report.

## Review

### Method
Read every line of both files, enumerated all 40 docstrings in `graph.ts` and 39 in `items.ts`, and verified each against the code below it. Specifically tested the three rejection failure modes: (1) validation-described-as-transformation, (2) false ordering/uniqueness/immutability, (3) nonexistent `@param`/`@returns`.

### Correct (with evidence) — notable true-claim verifications
- `graph.ts:181 compactError` — catch-path returns `raw.replace(/\s+/g,' ').trim()`; docstring's "trimmed raw text" matches. JSON-path order `detail || title || code` matches docstring's "JSON detail, title, or code".
- `items.ts:95 normalizeDepRelation` — this is the one function that genuinely transforms and returns the transformed value (`trim().toLowerCase().replace(/-/g,'_')` + alias map). Docstring correctly claims the transformation and the alias-fallback. **Not** a validation-as-transformation trap.
- `items.ts:134 depLabel` — returns `labels[normalizeDepRelation(rel)] || rel`, falling back to the **original** `rel`, exactly as the docstring states ("the original relationship string").
- `items.ts:678 relTime` — `just now` (<60s), `Nm/Nh/Nd ago` (<3600/86400/604800), else `toLocaleDateString()` (older than a week = 604800s). Matches exactly.
- `graph.ts:274 computeCriticalPath` — returns `new Set()` when `longest.length < 2`, matching "empty set when there is no multi-step chain."
- `graph.ts:1100 computeTagColorMap` — freq keyed by unique tag, sorted desc, sliced to palette length. No false order/dedup claim.
- `graph.ts:332 visibleGraph` — `connected` is the set of **all** ids across all relationships; docstring's "set of all connected node ids" is accurate (not misclaimed as the filtered subset).
- Top-N renderers (`renderHubs`, `renderBlockingInsights` → slice(0,8); `renderRelList` → slice(0,100)) all match their stated limits.

### Problems found
None. None of the docstrings exhibit any of the three failure modes:
- No function is described as transforming when it only validates — `normalizeDepRelation` and `compactError` are the only true transforms and they are correctly described.
- No false ordering/uniqueness/immutability claims (no `Object.fromEntries`-order claims; Sets described as sets; Maps not given false order guarantees; no array misclaimed as deduplicated).
- No `@param` or `@returns` tags are used anywhere (all docstrings are prose), so there are no param/return mismatches.
- No wrong return types, invented edge cases, or reversed side effects.

**All docstrings in both `public/src/views/graph.ts` and `public/src/views/items.ts` are accurate.**

### Residual risks
- This is a static read/inspection audit; it does not exercise runtime behavior. The docstrings accurately describe what the code currently does, but a future code change could silently invalidate them (no docstring tests exist).
- Two near-misses worth noting only as observations (not errors, not flagged): `addDep` docstring says "normalizes the target id and relationship" — the target id is only `.trim()`-ed (a legitimate whitespace normalization), while the relationship is fully normalized; the phrasing is defensible so I did not flag it. `compactError` returns `''` whenever the message *contains* the pm-graph substring, whereas the docstring says "when the error is *just* the missing pm-graph extension" — practically equivalent; not flagged.