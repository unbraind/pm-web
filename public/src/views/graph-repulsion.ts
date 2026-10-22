import type { PhysicsNode } from './graph-physics.js';

/** A square with aggregate mass and a fixed-order partition of its contents. */
interface Cell {
  x: number; y: number; size: number; count: number;
  cx: number; cy: number; children: Cell[];
}

/** Partition deterministically; depth and width bounds keep coincident points linear. */
function partition(points: PhysicsNode[], x: number, y: number, size: number, depth: number): Cell {
  const cell: Cell = { x, y, size, count: points.length, cx: 0, cy: 0, children: [] };
  for (const point of points) { cell.cx += point.x; cell.cy += point.y; }
  cell.cx /= cell.count; cell.cy /= cell.count;
  if (points.length === 1 || depth === 32 || size < 1e-6) return cell;
  const half = size / 2;
  const buckets: PhysicsNode[][] = [[], [], [], []];
  for (const point of points) {
    buckets[(point.x >= x + half ? 1 : 0) + (point.y >= y + half ? 2 : 0)].push(point);
  }
  for (let i = 0; i < 4; i++) {
    if (buckets[i].length) cell.children.push(partition(buckets[i], x + (i % 2) * half, y + (i >> 1) * half, half, depth + 1));
  }
  return cell;
}

/** Visit near cells exactly and accept distant centers of mass at theta = 0.75. */
function visit(node: PhysicsNode, cell: Cell, strength: number): void {
  const contains = node.x >= cell.x && node.x < cell.x + cell.size && node.y >= cell.y && node.y < cell.y + cell.size;
  if (cell.count === 1 && contains) return;
  let dx = cell.cx - node.x || 0.01;
  let dy = cell.cy - node.y || 0.01;
  let d2 = dx * dx + dy * dy;
  if (cell.children.length && (contains || cell.size * cell.size >= 0.5625 * d2)) {
    for (const child of cell.children) visit(node, child, strength);
    return;
  }
  // A terminal bucket may contain coincident points. Exclude the target's mass.
  const mass = cell.count - (contains ? 1 : 0);
  if (contains) {
    dx = (cell.cx - node.x) * cell.count / mass || 0.01;
    dy = (cell.cy - node.y) * cell.count / mass || 0.01;
    d2 = dx * dx + dy * dy;
  }
  if (d2 < 0.01) return;
  const force = strength * mass / (d2 * Math.sqrt(d2));
  node.vx -= dx * force; node.vy -= dy * force;
}

/** Keep the original symmetric force for small graphs, avoiding approximation drift. */
function exactRepulsion(nodes: PhysicsNode[], strength: number): void {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = b.x - a.x || 0.01, dy = b.y - a.y || 0.01;
      const d2 = dx * dx + dy * dy;
      if (d2 < 0.01) continue;
      const force = strength / (d2 * Math.sqrt(d2));
      a.vx -= dx * force; a.vy -= dy * force;
      b.vx += dx * force; b.vy += dy * force;
    }
  }
}

/** Apply deterministic Barnes-Hut repulsion in the worker and active frame loop. */
export function repelNodes(nodes: PhysicsNode[], strength: number): void {
  if (nodes.length <= 512) { exactRepulsion(nodes, strength); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x); minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x); maxY = Math.max(maxY, node.y);
  }
  const root = partition(nodes, minX, minY, Math.max(maxX - minX, maxY - minY, 1) + 1e-6, 0);
  for (const node of nodes) visit(node, root, strength);
}
