# Source coverage progress

This candidate advances pm-web-fy9a and leaves its all-source 100/100/100/100 acceptance open. Measurements cover every one of the 33 executable TypeScript files under `src`. Scripts and browser sources remain outside `coverageGate.sources`; their inventory is below. No coverage exclusions were added and no behavior was removed to increase percentages.

## Comparable measurements

Metric order throughout is **statements / branches / functions / lines**. c8 uses V8 counters mapped to Istanbul reports; statements and lines currently have the same totals. These are reporter-defined percentages, not a separate count of syntactic statements.

| Measurement | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Resumed c8 baseline, after recovered route fixes | 86.39 | 80.46 | 92.11 | 86.39 |
| Final verified c8 run | 90.22 | 79.34 | 93.90 | 90.22 |
| Previous enforced floors | absent | 79 | 75 | 79 |
| New enforced floors | 90 | 79 | 93 | 90 |

The interrupted run also recorded Node built-in coverage: lines 85.00, branches 81.40, functions 78.58, with no independently enforced statements metric. Its function accounting differs from c8, so changing reporters must not be credited as test improvement. Branch coverage decreased against the resumed c8 baseline as additional paths entered the V8 denominator; no branch-floor increase is claimed. A preceding passing run measured 79.35 branches, illustrating a one-counter concurrency variation, and both runs exceed the retained floor of 79.

Final counts: statements and lines **10,372/11,496**, branches **1,736/2,188**, functions **262/279**. The final verification passed **487/487 tests**, zero skips, in **115.965 seconds** of test-runner time (build time is additional). The preceding full run passed the same suite in 94.759 seconds. The resumed baseline passed 472/476 in 196.188 seconds; its four failures were optional live-fleet catalog drift, tracked separately below.

## Per-file baseline and final percentages

| Source | Resumed c8 baseline S/B/F/L | Final S/B/F/L |
| --- | --- | --- |
| `src/app.ts` | 95.45 / 82.35 / 100.00 / 95.45 | 95.45 / 82.35 / 100.00 / 95.45 |
| `src/auth.ts` | 96.36 / 88.23 / 100.00 / 96.36 | 96.36 / 88.23 / 100.00 / 96.36 |
| `src/board.ts` | 99.19 / 88.88 / 100.00 / 99.19 | 99.19 / 88.88 / 100.00 / 99.19 |
| `src/crypto.ts` | 100.00 / 100.00 / 100.00 / 100.00 | 100.00 / 100.00 / 100.00 / 100.00 |
| `src/csrf.ts` | 100.00 / 96.15 / 100.00 / 100.00 | 100.00 / 96.15 / 100.00 / 100.00 |
| `src/db.ts` | 94.46 / 73.33 / 100.00 / 94.46 | 94.46 / 73.33 / 100.00 / 94.46 |
| `src/health.ts` | 95.30 / 90.78 / 100.00 / 95.30 | 95.30 / 90.78 / 100.00 / 95.30 |
| `src/ical.ts` | 100.00 / 93.22 / 100.00 / 100.00 | 100.00 / 93.22 / 100.00 / 100.00 |
| `src/idempotency.ts` | 96.13 / 91.81 / 100.00 / 96.13 | 96.13 / 91.81 / 100.00 / 96.13 |
| `src/index.ts` | 86.06 / 81.91 / 80.00 / 86.06 | 86.06 / 81.91 / 80.00 / 86.06 |
| `src/middleware/auth.ts` | 100.00 / 100.00 / 100.00 / 100.00 | 100.00 / 100.00 / 100.00 / 100.00 |
| `src/oidc.ts` | 93.91 / 77.58 / 100.00 / 93.91 | 93.91 / 81.45 / 100.00 / 93.91 |
| `src/rate-limit.ts` | 100.00 / 100.00 / 100.00 / 100.00 | 100.00 / 100.00 / 100.00 / 100.00 |
| `src/routes/admin.ts` | 87.04 / 66.66 / 100.00 / 87.04 | 87.04 / 66.66 / 100.00 / 87.04 |
| `src/routes/auth.ts` | 91.21 / 89.28 / 100.00 / 91.21 | 91.21 / 89.28 / 100.00 / 91.21 |
| `src/routes/extensions.ts` | 95.47 / 72.50 / 100.00 / 95.47 | 95.47 / 72.50 / 100.00 / 95.47 |
| `src/routes/github.ts` | 57.61 / 66.66 / 72.72 / 57.61 | 57.61 / 66.66 / 72.72 / 57.61 |
| `src/routes/groups.ts` | 91.45 / 85.10 / 100.00 / 91.45 | 91.45 / 85.10 / 100.00 / 91.45 |
| `src/routes/oidc.ts` | 48.00 / 100.00 / 16.66 / 48.00 | 94.80 / 84.21 / 100.00 / 94.80 |
| `src/routes/pm.ts` | 70.29 / 67.93 / 87.17 / 70.29 | 83.59 / 67.22 / 84.61 / 83.59 |
| `src/routes/projects.ts` | 85.92 / 85.71 / 100.00 / 85.92 | 85.92 / 85.71 / 100.00 / 85.92 |
| `src/routes/route-helpers.ts` | 100.00 / 86.66 / 100.00 / 100.00 | 100.00 / 86.66 / 100.00 / 100.00 |
| `src/routes/route-params.ts` | 100.00 / 94.73 / 100.00 / 100.00 | 100.00 / 94.73 / 100.00 / 100.00 |
| `src/routes/sharing.ts` | 94.66 / 86.48 / 100.00 / 94.66 | 94.66 / 86.48 / 100.00 / 94.66 |
| `src/server.ts` | 91.02 / 81.81 / 100.00 / 91.02 | 91.02 / 81.81 / 100.00 / 91.02 |
| `src/services/fleet-snapshot.ts` | 100.00 / 100.00 / 100.00 / 100.00 | 100.00 / 100.00 / 100.00 / 100.00 |
| `src/services/mutation-event-watcher.ts` | 99.53 / 92.68 / 100.00 / 99.53 | 99.53 / 92.68 / 100.00 / 99.53 |
| `src/services/package-catalog.ts` | 100.00 / 100.00 / 100.00 / 100.00 | 100.00 / 100.00 / 100.00 / 100.00 |
| `src/services/pm-runner.ts` | 95.40 / 78.53 / 90.90 / 95.40 | 93.53 / 78.21 / 93.93 / 93.53 |
| `src/services/project-watcher.ts` | 98.74 / 88.70 / 100.00 / 98.74 | 98.74 / 90.47 / 100.00 / 98.74 |
| `src/services/realtime-bus.ts` | 93.64 / 76.78 / 92.30 / 93.64 | 93.64 / 76.78 / 92.30 / 93.64 |
| `src/services/sse.ts` | 93.68 / 92.59 / 95.00 / 93.68 | 93.68 / 93.65 / 95.00 / 93.68 |
| `src/services/watcher-utils.ts` | 100.00 / 92.30 / 100.00 / 100.00 | 100.00 / 93.33 / 100.00 / 100.00 |

## Exact remaining locations

Locations refer to the measured source revision in this candidate. Lines are zero-count LCOV `DA` records. Branch entries list source lines with at least one zero-count or untaken LCOV arm; function entries list starts of zero-count Istanbul functions. Multiple arms/functions can share a line. A `none` line list does not imply all branches were taken.

| Source | Uncovered lines | Lines containing untaken branch arms | Uncalled function starts |
| --- | --- | --- | --- |
| `src/app.ts` | 78-79, 94-95, 117-118, 174-177, 231-233 | 77, 93, 115-116, 182, 230 | none |
| `src/auth.ts` | 10-11 | 6, 9 | none |
| `src/board.ts` | 49 | 32, 49, 117 | none |
| `src/csrf.ts` | none | 50 | none |
| `src/db.ts` | 20-27, 230-234 | 19, 66, 229 | none |
| `src/health.ts` | 117-118, 222-226, 355-365 | 108, 115-116, 221, 319, 354, 373 | none |
| `src/ical.ts` | none | 133, 189, 237-238 | none |
| `src/idempotency.ts` | 397-401, 403-411, 413-415 | 179, 240, 244, 282, 304, 312, 396, 402, 412 | none |
| `src/index.ts` | 27-30, 196-211, 277, 297-298, 344-399, 460, 491-494 | 232-233, 269, 273, 275-276, 295-296, 459, 490, 497, 542, 554, 561, 580 | 25-26, 196, 343 |
| `src/oidc.ts` | 136-138, 161-162, 164-165, 170-171, 229-230, 299-300, 315-316, 318-319, 327-328, 404-405, 434-435, 441-442, 444-445, 451-452, 567-572 | 135-136, 160, 163, 169, 229, 231, 298, 314, 317, 326, 403, 429, 433, 440, 443, 450, 546, 554, 566 | none |
| `src/routes/admin.ts` | 38-40, 91-93, 108-110, 126-128, 137-139, 150-152, 166-168, 185-187, 201-203, 224-226, 243-244 | 13, 37, 84, 87, 90, 107, 125, 136, 149, 165, 184, 200, 222-223, 242 | none |
| `src/routes/auth.ts` | 84-86, 123-125, 145-147, 161-163, 186-188, 200-202 | 83, 122, 144, 160, 185, 199 | none |
| `src/routes/extensions.ts` | 235-246 | 147-153, 171, 207, 211, 235 | none |
| `src/routes/github.ts` | 130-140, 157-159, 193-195, 215-217, 257-264, 289-308, 312-325, 330-353, 358-381, 429-431, 442-444, 446-452, 454-455, 463-470, 475-538, 543-586, 591-608 | 28, 156, 192, 214, 248, 250, 387, 393, 416, 429, 433, 441, 445, 453 | 130, 257, 289 |
| `src/routes/groups.ts` | 30-32, 42-43, 108-110, 129-131, 144-146, 192-194, 229-231 | 29, 107, 124, 128, 143, 191, 228 | none |
| `src/routes/oidc.ts` | 49-50, 72-73, 107, 183-188, 216-217 | 48, 107, 182, 215, 240, 242 | none |
| `src/routes/pm.ts` | 35, 53-64, 80-83, 91-102, 113-116, 176-178, 191-193, 221, 235-246, 311-316, 341-342, 383-391, 402-404, 418-452, 459, 482-485, 576-599, 1090-1092, 1122-1156, 1304-1359, 1511-1512, 1517-1544, 1579-1580, 1590-1598, 1602-1603, 1671-1675, 1701-1704, 1709-1712, 1721-1723, 1740-1752, 1757-1760, 1765-1768, 1796-1800, 1805-1810, 1828-1830, 1875-1881, 2003-2005, 2046-2048, 2055-2057, 2073-2075, 2112, 2133-2145, 2150-2157, 2162-2165, 2170-2173, 2178-2181, 2186-2189, 2279-2281, 2317-2319, 2411-2413, 2464-2468, 2472-2481, 2489-2491, 2513-2516, 2529-2532, 2549-2554 | 32, 35, 79, 113, 175, 190, 201, 221, 276, 278, 310, 323, 326-330, 335-336, 340, 359-360, 382, 458-459, 494, 498, 541, 557, 644, 714, 800, 805, 855, 874, 877-881, 932, 941, 964-965, 978, 981, 988-989, 1006, 1020-1021, 1024, 1035, 1037, 1045, 1058, 1089, 1099, 1109, 1162, 1190, 1196, 1202, 1207, 1213, 1224, 1228, 1237, 1245, 1251, 1255, 1268, 1281, 1290, 1299, 1368, 1381, 1413, 1419, 1424, 1433, 1442, 1448, 1455, 1461, 1464, 1467, 1469, 1475, 1480, 1488, 1491, 1494, 1496, 1502, 1510, 1550, 1553, 1578, 1586, 1589-1590, 1599, 1601, 1609, 1612, 1618, 1622, 1628, 1631, 1633, 1639, 1642, 1644, 1650, 1653, 1655, 1661, 1664, 1666, 1681, 1691, 1695-1696, 1718, 1720-1721, 1730, 1735, 1774, 1781, 1783, 1789, 1791, 1822, 1827, 1836, 1863, 1867-1868, 1874, 1886, 1903, 1910, 1936, 1943, 1950, 1952, 1967, 1985, 2002, 2011, 2020, 2026, 2041, 2045, 2051, 2054, 2066, 2072, 2098, 2100, 2106, 2111, 2124, 2128, 2195, 2198, 2204, 2209-2210, 2212, 2232, 2245, 2265, 2272-2275, 2278, 2286, 2292, 2295-2296, 2302, 2313, 2316, 2330, 2341, 2349, 2366, 2374, 2385, 2393, 2401, 2406, 2410, 2418, 2424, 2438, 2440, 2447, 2488, 2511-2512, 2527-2528, 2533 | 53, 91, 235, 402, 418, 576 |
| `src/routes/projects.ts` | 79-81, 118-130, 137-139, 152-154, 175-177, 194-196 | 78, 117, 136, 151, 174, 193 | none |
| `src/routes/route-helpers.ts` | none | 53-54 | none |
| `src/routes/route-params.ts` | none | 17 | none |
| `src/routes/sharing.ts` | 81-83, 170-172, 191-193, 220-222 | 52, 80, 169, 190, 219 | none |
| `src/server.ts` | 48-50, 54-55, 76-77 | 32, 47 | none |
| `src/services/mutation-event-watcher.ts` | 90 | 90, 108 | none |
| `src/services/pm-runner.ts` | 165-170, 212-218, 236-238, 245, 375-377, 483-484, 495-496, 542-548, 562-568, 574-580, 720-722, 799-804, 813-819, 886-888, 896-898, 1021-1022 | 28, 67, 97, 131, 164, 175, 211, 227, 235, 251, 258, 316, 342, 346, 348, 354, 356, 482, 494, 541, 561, 573, 719, 798, 857, 859, 861, 878, 885, 893, 895, 950, 954, 959, 962, 982, 1020 | 374, 812 |
| `src/services/project-watcher.ts` | 137-138, 186-187 | 136, 185, 246, 263, 310, 313 | none |
| `src/services/realtime-bus.ts` | 187-190, 192-196, 216-221 | 63-64, 86, 126, 140, 144, 150, 158, 175, 186, 191, 208, 226 | 126 |
| `src/services/sse.ts` | 322-323, 344-345, 426-450 | 211, 321, 343, 411 | 425 |
| `src/services/watcher-utils.ts` | none | 27 | none |

Largest remaining line gaps are the GitHub provider routes, unexercised pm route commands/error paths, extension entry points and runner fallback paths. Remaining collaboration gaps include realtime-bus recovery/failure handling and SSE shutdown/error paths. Configured Neo4j integration is not exercised by the new unconfigured-sync regression. These locations require real boundary fixtures and behavioral assertions before another ratchet.

## Source inventory outside the gate

These TypeScript paths are not measured by the current `sources: ["src"]` declaration. Declaration files and any other type-only modules need explicit classification before widening the gate; executable files need genuine tests. No percentage is claimed for this inventory.

- `scripts/accept-packed.ts`
- `scripts/coverage-gate.ts`
- `scripts/db-down.ts`
- `scripts/db-up.ts`
- `scripts/docstring-gate.ts`
- `scripts/duplication-gate.ts`
- `scripts/ensure-test-db.ts`
- `scripts/generate-fleet-snapshot.ts`
- `scripts/init-test-schema.ts`
- `scripts/lint.ts`
- `scripts/main-invocation.ts`
- `scripts/prepare-merge-driver.ts`
- `scripts/verify-release-changelog-date.ts`
- `scripts/verify-release-publish-attestation.ts`
- `scripts/with-test-db.ts`
- `public/src/api-types.ts`
- `public/src/api.ts`
- `public/src/app.ts`
- `public/src/browser-window.ts`
- `public/src/components/modals.ts`
- `public/src/components/toast.ts`
- `public/src/constants.ts`
- `public/src/cookie-consent.ts`
- `public/src/filters.ts`
- `public/src/i18n.ts`
- `public/src/offline-recovery.ts`
- `public/src/state.ts`
- `public/src/sw.ts`
- `public/src/theme.ts`
- `public/src/types.ts`
- `public/src/utils.ts`
- `public/src/views/activity.ts`
- `public/src/views/admin.ts`
- `public/src/views/auth.ts`
- `public/src/views/calendar.ts`
- `public/src/views/comments-audit.ts`
- `public/src/views/config.ts`
- `public/src/views/context.ts`
- `public/src/views/create.ts`
- `public/src/views/dedupe.ts`
- `public/src/views/export.ts`
- `public/src/views/github.ts`
- `public/src/views/graph-canvas.ts`
- `public/src/views/graph.ts`
- `public/src/views/groups.ts`
- `public/src/views/guide.ts`
- `public/src/views/health.ts`
- `public/src/views/items.ts`
- `public/src/views/normalize.ts`
- `public/src/views/packages.ts`
- `public/src/views/plan-execution.ts`
- `public/src/views/plan.ts`
- `public/src/views/projects.ts`
- `public/src/views/router.ts`
- `public/src/views/search.ts`
- `public/src/views/settings.ts`
- `public/src/views/shared.ts`
- `public/src/views/sharing.ts`
- `public/src/views/stats.ts`
- `public/src/views/templates.ts`
- `public/src/views/validate.ts`

## Behavior and regressions

The additions drive the real Express application and disposable PostgreSQL with authenticated HTTP requests and real pm CLI workspaces. Two concurrent SSE clients assert single fan-out for a same-key mutation, replay suppression, changed-body rejection, both concurrent edits in verified CLI history, owner-bound presence and raw filesystem watcher changes. The watcher uses its real database, directory and SSE collaborators. The OIDC fixture serves actual HTTPS discovery, JWKS and token endpoints, validates PKCE, signs RS256 tokens and checks returning identity persistence, state rejection and redeemed-code replay. Only a disposable fixture certificate is trusted by the isolated app process; OpenSSL is required for that test.

Route round trips verify files/docs/learnings, claims, project configuration, import partial failures, JSON/YAML/CSV escaping, filtered bulk preview/application, status shortcuts, task transitions and plan lifecycle persistence. Existing extension-surface harness tests remain enabled.

Fixed regressions are tracked independently:

- pm-web-i1mr: plan step title/body flags were forwarded as plan-level flags.
- pm-web-t0mu: plan step linking omitted the required step positional argument.
- pm-web-957x: linked-test command/note serialization did not match the SDK contract.
- pm-web-culw: close-many used a status mutation flag instead of the selection filter.
- pm-web-4fgv: automatic graph sync provisioned an extension before checking whether Neo4j was configured; configuration is now checked first and both SSE error aliases remain available.
- pm-web-juk7: spawned plan commands inherited a foreign PM_PATH despite the requested project cwd; spawned commands now bind PM_PATH to the requested project.
- pm-web-sblf: a source/configuration failure could leave prior accepted coverage receipts; all three receipts are invalidated before configuration reads.

The four recovered CLI contract regressions failed on the original implementation. The graph and foreign-PM_PATH regressions also failed before their fixes. Coverage-gate fixture tests execute the real script and c8: unloaded files contribute zero counters, statements are checked independently, failed/configuration-invalid runs clear accepted reports and a missing metric is rejected.

## Reproduction and scope

Run `npm ci`. The existing `scripts/with-test-db.ts` runner owns disposable database setup; use its dedicated test database configuration. Never point these commands at deployment resources.

Catalog tests support an optional external fleet read. A package worktree farm is misidentified by implicit sibling discovery (pm-web-cqwm), while the current external fleet has pm-jev absent from this package's committed catalog/snapshot (pm-web-s99c). Those assertions are preserved. The passing scoped run supplies a disposable filesystem fixture from the independent committed snapshot, proving package/snapshot consistency, not current external-fleet freshness:

```bash
node --input-type=module <<'JS'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const snapshot = JSON.parse(readFileSync('test/fleet-extensions.snapshot.json', 'utf8'));
for (const entry of snapshot) {
  const dir = `coverage/fleet-fixture/${entry.name}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/manifest.json`, JSON.stringify({
    name: entry.name, description: entry.description, capabilities: entry.capabilities,
  }));
  writeFileSync(`${dir}/package.json`, JSON.stringify({
    name: entry.name, description: entry.packageDescription,
    ...(entry.publishable ? { publishConfig: { access: 'public' } } : {}),
  }));
}
JS
PM_FLEET_ROOT=coverage/fleet-fixture npm run coverage
```

Also passed: `npm run typecheck`, `npm run build:test`, `npm run lint`, `npm run duplication` (zero clones), `npm run docstring`, `npm run audit:prod` (zero production vulnerabilities), `pm health --strict-exit --json`, `pm validate --json` and the identity/privacy tests. The two linked owner test commands pass through `pm test pm-web-fy9a --run --progress`; graph, foreign-root and gate regression items also have passing linked tests. Validation retains existing non-fatal warnings; health reports no issues.

This is public package evidence. It does not establish deployed tenant isolation, production recovery, scale or readiness. The coverage item and follow-ups remain open.
