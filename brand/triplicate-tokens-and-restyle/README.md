# Triplicate review screenshots

All images contain synthetic fixtures. Each requested view has a before and
after at 1440, 768 and 390 CSS pixels, in light and dark system color schemes.
Before is the unchanged main UI at 54c694b. It has no board or live-arrival
signature, so those baseline frames show its existing item list.

The token migration is a separate commit from the restyle. Its five-view,
six-configuration pixel comparison is recorded in the accompanying JSON.
The after live-arrival frames pause the real 700 ms CSS animation at 350 ms.
The browser report records keyboard traversal, painted text contrast,
viewport overflow, primary-action count and live-arrival behavior.

Round 1 source head: `0e8ba11af09343e1788ab399b455d88a498c0335`. The AFTER set has 140 fresh PNGs;
the 108 BEFORE PNGs remain unchanged. Arrival screenshots include 350 ms and
settled frames in list, board and detail. Mobile disclosure frames cover both
themes. Browser acceptance passes 332 audits, 9,806 Tab stops, 2,167 painted
contrast pairs and 42 live-update cases. See release-gates.json for the exact
head release acceptance and honest local-attempt results.

The portability correction changes only the lockfile and review/tracker notes.
Rendered sources match the captured tree. Bun 1.4.3 npm-to-Bun migration passes
with the exact Git commit retained and the optional npm archive checksum omitted.
