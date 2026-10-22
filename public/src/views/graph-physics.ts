import type { CanvasNode } from './graph-canvas.js';
import { repelNodes } from './graph-repulsion.js';

/** Mutable physics position, copied to a worker so the visible graph stays static. */
export interface PhysicsNode extends CanvasNode { x: number; y: number; vx: number; vy: number; fx: number | null; fy: number | null }
/** Spring endpoints share the copied node identities. */
export interface PhysicsEdge { source: PhysicsNode; target: PhysicsNode }
/** Current control values used by both frame physics and background settling. */
export interface PhysicsParams { repulsion: number; facetDistance: number; linkDistance: number; linkStrength: number; centerForce: number }
/** One self-contained request to compute the existing 180-step force layout. */
export interface SettleRequest { nodes: PhysicsNode[]; edges: PhysicsEdge[]; params: PhysicsParams; tags: string[] }

/** Advance shared force physics with spatial repulsion, returning the cooled alpha. */
export function tickPhysics(nodes: PhysicsNode[], edges: PhysicsEdge[], params: PhysicsParams, tagColors: Set<string>, a: number): number {
    repelNodes(nodes, params.repulsion * a);

    // Spring forces
    for (const e of edges) {
      const { source: s, target: t } = e;
      const dx = t.x - s.x || 0.01;
      const dy = t.y - s.y || 0.01;
      const d  = Math.sqrt(dx * dx + dy * dy);
      const restLen = (s.lane === 'facet' || t.lane === 'facet')
        ? params.facetDistance
        : params.linkDistance;
      const f  = (d - restLen) * params.linkStrength * a;
      const nx = dx / d;
      const ny = dy / d;
      s.vx += nx * f; s.vy += ny * f;
      t.vx -= nx * f; t.vy -= ny * f;
    }

    // Center gravity
    for (const nd of nodes) {
      nd.vx -= nd.x * params.centerForce * a;
      nd.vy -= nd.y * params.centerForce * a;
    }

    // Tag centroid grouping — nodes sharing a tag gently attract each other
    if (tagColors.size > 0) {
      const tagCent = new Map<string, { x: number; y: number; count: number }>();
      for (const nd of nodes) {
        for (const t of nd.tags ?? []) {
          if (!tagColors.has(t)) continue;
          let c = tagCent.get(t);
          if (!c) { c = { x: 0, y: 0, count: 0 }; tagCent.set(t, c); }
          c.x += nd.x; c.y += nd.y; c.count++;
          break;
        }
      }
      const cs = 0.004 * a;
      for (const nd of nodes) {
        for (const t of nd.tags ?? []) {
          if (!tagColors.has(t)) continue;
          const c = tagCent.get(t);
          if (c && c.count >= 2) {
            nd.vx += (c.x / c.count - nd.x) * cs;
            nd.vy += (c.y / c.count - nd.y) * cs;
          }
          break;
        }
      }
    }

    // Integrate
    for (const nd of nodes) {
      nd.vx *= 0.56;
      nd.vy *= 0.56;
      if (nd.fx !== null) { nd.x = nd.fx; nd.vx = 0; }
      else nd.x += nd.vx;
      if (nd.fy !== null) { nd.y = nd.fy; nd.vy = 0; }
      else nd.y += nd.vy;
    }

    return a * .98;

}
