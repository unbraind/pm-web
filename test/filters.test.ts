import assert from "node:assert/strict";
import test from "node:test";

// The filter (de)serialization helpers are pure and live in the frontend
// bundle (compiled to public/src/filters.js by the public tsconfig). They are
// loaded here via a runtime dynamic import of the built JS so the test program
// (rootDir: test/) does not pull the frontend TypeScript sources into its
// compilation graph.
const filtersUrl = new URL("../public/src/filters.js", import.meta.url).href;
const mod: any = await import(filtersUrl);
const { filtersToQueryString, filtersFromSearchParams, hasActiveFilters, EMPTY_FILTERS } = mod;

test("filtersToQueryString omits empty dimensions and is deterministic", () => {
  const qs = filtersToQueryString({
    status: "open", type: "Feature", priority: "", sprint: "", release: "", assignee: "alice", tag: "release",
  });
  assert.equal(qs, "status=open&type=Feature&assignee=alice&tag=release");
});

test("filtersToQueryString returns '' when no filters are active", () => {
  assert.equal(filtersToQueryString({ ...EMPTY_FILTERS }), "");
});

test("filtersFromSearchParams round-trips a serialized filter set", () => {
  const original = {
    status: "in_progress", type: "Issue", priority: "1", sprint: "S1", release: "v2", assignee: "bob", tag: "urgent",
  };
  const parsed = filtersFromSearchParams(filtersToQueryString(original));
  assert.deepEqual(parsed, original);
});

test("filtersFromSearchParams defaults missing keys to empty and ignores unknown keys", () => {
  const parsed = filtersFromSearchParams("status=open&bogus=x");
  assert.equal(parsed.status, "open");
  assert.equal(parsed.type, "");
  assert.equal(parsed.tag, "");
  assert.equal(parsed["bogus"], undefined);
});

test("hasActiveFilters detects whether any dimension is set", () => {
  assert.equal(hasActiveFilters({ ...EMPTY_FILTERS }), false);
  assert.equal(hasActiveFilters({ ...EMPTY_FILTERS, tag: "x" }), true);
});
