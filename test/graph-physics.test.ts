import assert from 'node:assert/strict';
import test from 'node:test';
import { tickPhysics } from '../public/src/views/graph-physics.js';
import type { PhysicsNode } from '../public/src/views/graph-physics.ts';
import { graphFixture } from '../scripts/graph-scale-fixture.ts';

/** Independent pairwise reference for the original repulsion law, without springs. */
function reference(nodes: PhysicsNode[], strength: number): void {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    const dx = b.x - a.x || .01, dy = b.y - a.y || .01;
    const d2 = dx * dx + dy * dy;
    if (d2 < .01) continue;
    const force = strength / d2, distance = Math.sqrt(d2);
    const fx = dx / distance * force, fy = dy / distance * force;
    a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
  }
}

/** Observe actual distance evaluations in the public tick, including a behavioral revert. */
function forceWork(count: number): number {
  const fixture = graphFixture(count);
  const sqrt = Math.sqrt;
  let calls = 0;
  Math.sqrt = (value: number): number => { calls++; return sqrt(value); };
  try { tickPhysics(fixture.nodes, [], fixture.params, new Set(), .3); }
  finally { Math.sqrt = sqrt; }
  return calls;
}

test('repulsion work stays sub-quadratic when the graph grows fourfold', () => {
  const small = forceWork(1000), large = forceWork(4000);
  assert.ok(large < small * 7, `${small} -> ${large} distance evaluations must grow below 7x`);
  assert.ok(large < 4000 * 4000 / 12, 'distant cells must replace most pairwise evaluations');
});

test('spatial forces preserve small layouts and approximate large forces within 5% RMS', () => {
  for (const count of [2, 32, 64, 500, 2000]) {
    const fixture = graphFixture(count);
    const exact = structuredClone(fixture.nodes);
    reference(exact, 600);
    tickPhysics(fixture.nodes, [], { ...fixture.params, centerForce: 0 }, new Set(), .3);
    let error = 0, signal = 0;
    for (const [i, node] of fixture.nodes.entries()) {
      error += (node.vx / .56 - exact[i].vx) ** 2 + (node.vy / .56 - exact[i].vy) ** 2;
      signal += exact[i].vx ** 2 + exact[i].vy ** 2;
    }
    assert.ok(Math.sqrt(error / signal) < (count <= 64 ? 1e-12 : .05), `force quality at ${count} nodes: ${Math.sqrt(error / signal)}`);
  }
});

test('settling is deterministic, finite and respects fixed coordinates, facets and tags', () => {
  const fixture = graphFixture(500, 'clusters');
  fixture.nodes[0].fx = 12; fixture.nodes[0].fy = -34;
  fixture.nodes[1].lane = 'facet';
  for (const node of fixture.nodes) node.tags = ['group'];
  const copy = structuredClone(fixture);
  for (const request of [fixture, copy]) {
    let alpha = .3;
    for (let step = 0; step < 180; step++) alpha = tickPhysics(request.nodes, request.edges, request.params, new Set(['group']), alpha);
    assert.equal(request.nodes[0].x, 12); assert.equal(request.nodes[0].y, -34);
    assert.ok(request.nodes.every(node => [node.x, node.y, node.vx, node.vy].every(Number.isFinite)));
    assert.ok(alpha < .01);
  }
  assert.deepEqual(fixture.nodes, copy.nodes);
});

test('coincident, collinear, empty and singleton graphs terminate without self-force', () => {
  for (const count of [0, 1, 65, 2000]) {
    const fixture = graphFixture(count);
    for (const node of fixture.nodes) { node.x = 0; node.y = 0; }
    tickPhysics(fixture.nodes, [], fixture.params, new Set(), .3);
    assert.ok(fixture.nodes.every(node => node.x === 0 && node.y === 0));
    for (const [i, node] of fixture.nodes.entries()) node.x = i;
    tickPhysics(fixture.nodes, [], fixture.params, new Set(), .3);
    assert.ok(fixture.nodes.every(node => [node.x, node.y].every(Number.isFinite)));
  }
});
