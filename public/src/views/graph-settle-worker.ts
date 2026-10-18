import { tickPhysics, type SettleRequest } from './graph-physics.js';

// A module worker has its own global message scope and never touches the DOM.
self.onmessage = (event: MessageEvent<SettleRequest>) => {
  const { nodes, edges, params, tags } = event.data;
  const tagColors = new Set(tags);
  let alpha = .3;
  for (let step = 0; step < 180; step++) alpha = tickPhysics(nodes, edges, params, tagColors, alpha);
  self.postMessage(nodes.map(({ x, y, vx, vy }) => ({ x, y, vx, vy })));
};
