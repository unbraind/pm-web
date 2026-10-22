import type { PhysicsNode, SettleRequest } from '../public/src/views/graph-physics.ts';

/** Stable sunflower positions and sparse links, matching the canvas's initial seed. */
export function graphFixture(count: number, shape: 'chain' | 'clusters' = 'chain'): SettleRequest {
  const nodes: PhysicsNode[] = Array.from({ length: count }, (_, i) => {
    const radius = 70 + Math.sqrt(i) * 60;
    return {
      id: `scale-${i}`, label: `Task ${i + 1}`, type: 'Task', status: 'open', lane: 'item', degree: 2,
      x: Math.cos(i * 2.399963) * radius, y: Math.sin(i * 2.399963) * radius,
      vx: 0, vy: 0, fx: null, fy: null,
    };
  });
  const edges = nodes.slice(1).map((target, i) => ({ source: nodes[shape === 'chain' ? i : Math.floor(i / 25) * 25], target }));
  return { nodes, edges, tags: [], params: { repulsion: 2000, facetDistance: 100, linkDistance: 140, linkStrength: .065, centerForce: .01 } };
}
