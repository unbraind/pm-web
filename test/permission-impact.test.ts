import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PermissionImpactError, parsePermissionImpact, parsePermissionImpactPage } from '../src/permission-impact.ts';
import { PermissionImpactClient } from '../src/permission-impact-client.ts';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import { isPmCliExpectedError } from '@unbrained/pm-cli/sdk';
import extension from '../src/index.ts';
import { createPlainContractTracker } from './helpers/plain-contract-tracker.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const shareId = '12345678-1234-1234-1234-123456789abc';
/** Match a stable refusal with an actionable remedy. */
function invalid(error: unknown): boolean { return error instanceof PermissionImpactError && error.code === 'invalid_input' && error.remedy.length > 10; }
/** Construct one producer-shaped page to exercise the common output validator. */
function page() { return { protocol: 'pm-web-permission-impact/v1', mode: 'preview', applied: false, proposal: { shareId, permission: 'none' }, total: 1, nextOffset: null, counts: { packets: 1, decisions: 0, operations: 0 }, losses: [{ kind: 'packet', id: shareId, loss: 'read' }], unknownCapabilities: 'disabled', remedy: 'Refresh before applying separately.' }; }

test('one strict schema rejects coercion, unknown fields, sparse arrays and all nonfinite or excessive numbers', () => {
  assert.deepEqual(parsePermissionImpact({ shareId: shareId.toUpperCase(), permission: 'view' }), { shareId, permission: 'view', offset: 0, limit: 20 });
  for (const raw of [null, [], '', { shareId, permission: 'admin' }, { shareId, permission: ' view ' }, { shareId: ` ${shareId}`, permission: 'view' }, { shareId, permission: 'view', actor: 'owner' }, { shareId, permission: ['view'] }, Object.assign(Object.create({ scope: 'hidden' }), { shareId, permission: 'view' })]) assert.throws(() => parsePermissionImpact(raw), invalid);
  for (const n of [NaN, Infinity, -Infinity, -1, 0.1, Number.MAX_SAFE_INTEGER, '1', null, [], {}, true]) {
    assert.throws(() => parsePermissionImpact({ shareId, permission: 'view', offset: n }), invalid);
    assert.throws(() => parsePermissionImpact({ shareId, permission: 'view', limit: n }), invalid);
    assert.throws(() => parsePermissionImpactPage({ ...page(), total: n }), invalid);
    assert.throws(() => parsePermissionImpactPage({ ...page(), counts: { packets: n, decisions: 0, operations: 0 } }), invalid);
  }
  assert.throws(() => parsePermissionImpact({ shareId, permission: 'view', limit: 0 }), invalid);
  assert.throws(() => parsePermissionImpactPage({ ...page(), losses: new Array(1) }), invalid);
  for (const patch of [{ total: 2 }, { nextOffset: 1 }, { applied: true }, { unknownCapabilities: 'enabled' }, { losses: [{ kind: 'packet', id: shareId, loss: 'execute' }] }, { losses: [{ kind: 'unknown', id: shareId, loss: 'read' }] }, { losses: [{ kind: 'packet', id: '', loss: 'read' }] }, { losses: [{ kind: ['packet'], id: shareId, loss: 'read' }] }, { losses: [{ kind: 'packet', id: shareId, loss: ['read'] }] }, { losses: [{ kind: 'decision', id: shareId, loss: 'execute' }] }, { counts: { packets: 0, decisions: 1, operations: 0 } }, { remedy: '' }, { proposal: { shareId, permission: 'none', offset: 0 } }]) assert.throws(() => parsePermissionImpactPage({ ...page(), ...patch }), invalid);
});

test('seeded extreme producer outputs always validate and round-trip through the same schema', () => {
  let seed = 0x18c7b4;
  for (let i = 0; i < 1000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const total = seed % 1000001, packets = seed % (total + 1), decisions = (total - packets) >> 1;
    const row = { ...page(), total, counts: { packets, decisions, operations: total - packets - decisions }, losses: [] };
    assert.deepEqual(parsePermissionImpactPage(JSON.parse(JSON.stringify(row))), parsePermissionImpactPage(row));
    assert.deepEqual(parsePermissionImpact(JSON.parse(JSON.stringify({ shareId: randomUUID(), permission: 'none', offset: seed % 1000001, limit: 1 + seed % 50 }))).limit, 1 + seed % 50);
  }
});

test('CLI validates before network access and remote clients reject unsafe origins and unreachable servers', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'permission-command-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { pmRoot } = await createPlainContractTracker(cwd);
  const host = await createExtensionTestHarness(extension, { name: 'pm-web', capabilities: ['commands', 'schema'] });
  t.after(() => host.deactivate());
  for (const options of [{}, { share: shareId, permission: 'none', limit: '' }, { share: shareId, permission: 'none', offset: 'Infinity' }, { share: shareId, permission: 'none', limit: '51' }, { share: shareId, permission: 'none' }]) await assert.rejects(host.runCommand({ command: 'web permission-impact', pmRoot, options }), isPmCliExpectedError);
  for (const url of ['invalid', 'http://example.test', 'https://user@example.test', 'https://example.test/path', 'https://example.test?x=1', 'https://example.test#x']) assert.throws(() => new PermissionImpactClient(url, 'synthetic'), invalid);
  assert.ok(new PermissionImpactClient('http://[::1]:4000', 'synthetic'));
  await assert.rejects(new PermissionImpactClient('http://127.0.0.1:1', 'synthetic').preview(shareId, { shareId, permission: 'none' }), error => error instanceof PermissionImpactError && error.code === 'unavailable');
});
