import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('graph measurements render as one contiguous table with every recorded observation', () => {
  const guide = readFileSync(new URL('../docs/performance/graph-layout.md', import.meta.url), 'utf8');
  const measurements = JSON.parse(readFileSync(new URL('../docs/performance/graph-layout-measurements.json', import.meta.url), 'utf8')) as {
    observations: {
      nodes: number;
      before: { settleMs: number; frameP95Ms: number; inputP95Ms: number };
      after: { settleMs: number; frameP95Ms: number; inputP95Ms: number };
      settleSpeedup: number;
    }[];
  };
  const lines = guide.split('\n');
  const header = lines.findIndex(line => line.startsWith('| Nodes |'));
  assert.ok(header >= 0, 'the measurement table must have a header');
  assert.match(lines[header + 1], /^\|(?:\s*:?-+:?\s*\|){6}$/);
  const rows: string[][] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.split('|').slice(1, -1).map(cell => cell.trim()));
  }
  assert.deepEqual(rows, measurements.observations.map(({ nodes, before, after, settleSpeedup }) => [
    nodes.toLocaleString('en-US'),
    (before.settleMs / 1000).toFixed(3),
    (after.settleMs / 1000).toFixed(3),
    `${settleSpeedup.toFixed(2)}×`,
    `${before.frameP95Ms.toFixed(1)} / ${after.frameP95Ms.toFixed(1)}`,
    `${before.inputP95Ms.toFixed(1)} / ${after.inputP95Ms.toFixed(1)}`,
  ]), 'every observation must stay inside the table and match the raw measurements');
});
