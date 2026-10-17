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
