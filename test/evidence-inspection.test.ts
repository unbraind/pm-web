import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PmClient, isPmCliExpectedError, mutateItem, readSettings } from '@unbrained/pm-cli/sdk';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import { cite, tokens, validateRecord } from 'pm-evidence';
import { inspectEvidence } from '../src/services/evidence-inspection.ts';
import { EvidenceInspectionClient } from '../src/evidence-inspection-client.ts';
import { EvidenceInspectionError, parseEvidenceInspection, parseEvidenceInspectionPage } from '../src/evidence-inspection.ts';
import { evidenceInspectionMarkup } from '../public/src/views/evidence-inspection.ts';
import extension from '../src/index.ts';
import { evidenceTracker } from './helpers/evidence-tracker.ts';

/** Use real temporary SDK trackers fenced from ancestor Git discovery. */
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-inspection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return evidenceTracker(root);
}
/** Match actionable typed input refusals without reflecting operands. */
function invalid(error: unknown): boolean { return error instanceof EvidenceInspectionError && error.code === 'invalid_input' && error.remedy.length > 10; }

test('one strict boundary and producer-derived page schema reject extreme and sparse operands', async t => {
  const host = await fixture(t), page = await inspectEvidence(host, { item: host.id });
  assert.deepEqual(parseEvidenceInspectionPage(JSON.parse(JSON.stringify(page))), page);
  assert.ok(tokens(page) <= 2400); assert.equal(page.estimatedTokens, tokens(page));
  for (const input of [null, [], {}, { item: host.id, root: 'other' }, { item: host.id, record: true }, { item: host.id, source: 'other' }, { item: '../other' }]) assert.throws(() => parseEvidenceInspection(input), invalid);
  for (const number of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_VALUE, '2', null, [], {}]) {
    for (const key of ['offset', 'limit', 'budget']) assert.throws(() => parseEvidenceInspection({ item: host.id, [key]: number }), invalid);
    for (const key of ['total', 'offset', 'nextOffset', 'omitted', 'estimatedTokens', 'sourceReads', 'omittedCriterionGaps']) if (key !== 'nextOffset' || number !== null) assert.throws(() => parseEvidenceInspectionPage({ ...page, [key]: number }), EvidenceInspectionError);
    assert.throws(() => parseEvidenceInspectionPage({ ...page, rows: [{ ...page.rows[0], cited: { ...page.rows[0].cited, omittedCharacters: number } }] }), EvidenceInspectionError);
  }
  assert.throws(() => parseEvidenceInspectionPage({ ...page, rows: new Array(1) }), EvidenceInspectionError);
  assert.throws(() => parseEvidenceInspectionPage({ ...page, rows: [{ ...page.rows[0], bindings: new Array(1) }] }), EvidenceInspectionError);
  assert.throws(() => parseEvidenceInspectionPage({ ...page, criterionGaps: new Array(1) }), EvidenceInspectionError);
  let seed = 0x1784;
  for (let iteration = 0; iteration < 1000; iteration++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const input = { item: host.id, offset: seed % 1000001, limit: 1 + seed % 20, budget: 400 + seed % 15601 };
    assert.deepEqual(parseEvidenceInspection(JSON.parse(JSON.stringify(input))), input);
    const emitted = { ...page, rows: [], total: seed % 1000001, omitted: seed % 1000001, nextOffset: null, offset: seed % 1000001, estimatedTokens: seed % 1000001 };
    assert.deepEqual(parseEvidenceInspectionPage(JSON.parse(JSON.stringify(emitted))), emitted);
  }
  for (const budget of [400, 600, 1200, 2400, 16000]) {
    try { const result = await inspectEvidence(host, { item: host.id, budget }); assert.ok(result.estimatedTokens <= budget); assert.equal(result.omitted, result.total - result.rows.length); }
    catch (error) { assert.ok(error instanceof EvidenceInspectionError && error.code === 'budget'); }
  }
});

test('editing one allowed source changes only its displayed facts, including ambiguity and criterion support', async t => {
  const host = await fixture(t), before = await inspectEvidence(host, { item: host.id });
  assert.equal(before.rows[0].freshness, 'current'); assert.equal(before.rows[0].bindings[0].support, 'current-source');
  await writeFile(path.join(host.root, 'source-0.txt'), 'before one\nreplacement\nafter one');
  const after = await inspectEvidence(host, { item: host.id });
  assert.equal(after.rows[0].freshness, 'changed'); assert.equal(after.rows[0].current.text, 'replacement');
  assert.equal(after.rows[0].bindings[0].support, 'lost-source'); assert.deepEqual(after.rows[1], before.rows[1]);
  await writeFile(path.join(host.root, 'source-0.txt'), `${host.texts[0]}\n${host.texts[0]}`);
  const ambiguous = await inspectEvidence(host, { item: host.id });
  assert.equal(ambiguous.rows[0].resolution, 'ambiguous'); assert.equal(ambiguous.rows[0].freshness, 'unknown');
  assert.deepEqual(ambiguous.rows[1], before.rows[1]);
  assert.match(evidenceInspectionMarkup(ambiguous), /ambiguous/); assert.match(evidenceInspectionMarkup(ambiguous), /does not prove completion/);
  await host.client.update(host.id, { acceptanceCriteria: 'Replacement criterion; Second source remains current' });
  const criterion = await inspectEvidence(host, { item: host.id });
  assert.equal(criterion.rows[0].bindings[0].support, 'criterion-changed');
});

test('500 seeded operation sequences re-read native SDK state and preserve replay, CRLF, relationships and every native field', async t => {
  const host = await fixture(t), native = (await host.client.get(host.id, { full: true })).item;
  const settings = await readFile(path.join(host.workspace, 'settings.json'));
  const history = await readFile(path.join(host.workspace, 'history', `${host.id}.jsonl`));
  const oldCeiling = process.env.GIT_CEILING_DIRECTORIES, oldPath = process.env.PATH;
  process.env.GIT_CEILING_DIRECTORIES = tmpdir(); process.env.PATH = host.root;
  t.after(() => { if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling; if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  let seed = 0x51ed123;
  /** A deterministic operation stream has no SDK or selector normalization in its oracle. */
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const originals = ['original one', 'original two'];
  const variants = originals.map((text, index) => [host.texts[index], host.texts[index].replace(text, `replacement ${index}`), host.texts[index].replaceAll('\n', '\r\n'), host.texts[index].replace(text, ` ${text} `), host.texts[index].replace(text, `${text}\t`)]);
  const model = ['current', 'current']; let operations = 0;
  for (let sequence = 0; sequence < 500; sequence++) {
    const length = 2 + random() % 5;
    for (let step = 0; step < length; step++) {
      const index = random() % 2, variant = random() % variants[index].length, value = variants[index][variant];
      model[index] = ['current', 'changed', 'unknown', 'unknown', 'unknown'][variant]; await writeFile(path.join(host.root, `source-${index}.txt`), value); operations++;
    }
    const result = await inspectEvidence(host, { item: host.id });
    assert.deepEqual(result.rows.map(row => row.freshness), model, `sequence ${sequence}`);
    assert.deepEqual((await host.client.get(host.id, { full: true })).item, native);
    assert.deepEqual(parseEvidenceInspectionPage(JSON.parse(JSON.stringify(result))), result);
    assert.equal(result.estimatedTokens, tokens(result));
    validateRecord(JSON.parse(String(native.evidence_state)), host.id);
  }
  assert.deepEqual(await readFile(path.join(host.workspace, 'settings.json')), settings);
  assert.deepEqual(await readFile(path.join(host.workspace, 'history', `${host.id}.jsonl`)), history);
  console.log(JSON.stringify({ seed: '51ed123', sequences: 500, operations, sdkStatePreserved: true, schemaWrites: 0, gitAvailable: false }));
});

test('foreign records fail alone and source readers refuse traversal and symlinks across project roots', async t => {
  const host = await fixture(t), before = (await host.client.get(host.id, { full: true })).item;
  /** Persist legacy/foreign fixture bytes with the native SDK writer, retaining append-only history. */
  const seedState = async (value: string) => mutateItem({ pmRoot: host.workspace, settings: await readSettings(host.workspace), id: host.id, op: 'update', author: 'evidence-test', message: 'Seed foreign fixture', mutate(document) { document.metadata.evidence_state = value; return { changedFields: ['evidence_state'] }; } });
  const state = JSON.parse(String(before.evidence_state)) as { citations: unknown[] };
  state.citations.splice(1, 0, { id: 'invalid' });
  await seedState(JSON.stringify(state));
  const mixed = await inspectEvidence(host, { item: host.id });
  assert.deepEqual(mixed.rows.map(row => row.freshness), ['current', 'unknown', 'current']);
  assert.equal(mixed.rows[1].code, 'schema');
  await seedState(String(before.evidence_state));
  const outside = await mkdtemp(path.join(tmpdir(), 'evidence-foreign-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'source.txt'), 'foreign secret');
  await rm(path.join(host.root, 'source-0.txt')); await symlink(path.join(outside, 'source.txt'), path.join(host.root, 'source-0.txt'));
  const denied = await inspectEvidence(host, { item: host.id });
  assert.equal(denied.rows[0].code, 'boundary'); assert.ok(!JSON.stringify(denied).includes('foreign secret'));
  await seedState('{"version":900}');
  const foreign = await inspectEvidence(host, { item: host.id });
  assert.equal(foreign.rows[0].code, 'schema'); assert.match(foreign.rows[0].remedy!, /Foreign/);
});

test('interleaving at each real SDK read boundary refuses changed state; no lock isolation is claimed', async t => {
  const host = await fixture(t);
  /** Instrument genuine SDK reads, injecting an ordinary competing SDK writer before a selected boundary. */
  class InterleavedClient extends PmClient {
    reads = 0; boundary = Infinity;
    /** Execute a competing native transition while keeping every read on the real SDK. */
    override get: PmClient['get'] = async (id, options) => {
      this.reads++;
      if (this.reads === this.boundary) await host.client.update(host.id, { title: `Peer transition ${this.boundary}` });
      return super.get(id, options);
    };
  }
  const client = new InterleavedClient({ cwd: host.root, pmRoot: host.workspace, noExtensions: true });
  await inspectEvidence({ ...host, client }, { item: host.id }); const boundaries = client.reads;
  for (let boundary = 2; boundary <= boundaries; boundary++) {
    client.reads = 0; client.boundary = boundary;
    await assert.rejects(inspectEvidence({ ...host, client }, { item: host.id }), error => error instanceof EvidenceInspectionError && error.code === 'conflict');
  }
  console.log(JSON.stringify({ realSdkReadBoundaries: boundaries, competingTransitions: boundaries - 1 }));
});

test('SDK/CLI reject unsupported input before network and packed command registration is public', async t => {
  const host = await fixture(t), harness = await createExtensionTestHarness(extension, { name: 'pm-web', capabilities: ['commands', 'schema'] });
  t.after(() => harness.deactivate());
  for (const options of [{}, { item: host.id, budget: 'Infinity' }, { item: host.id, limit: '' }, { item: host.id }]) await assert.rejects(harness.runCommand({ command: 'web evidence', pmRoot: host.workspace, options }), isPmCliExpectedError);
  for (const origin of ['invalid', 'http://example.test', 'https://user@example.test', 'https://example.test/path']) assert.throws(() => new EvidenceInspectionClient(origin, 'synthetic'), invalid);
  await assert.rejects(new EvidenceInspectionClient('https://example.test', 'synthetic').inspect('invalid-project', { item: host.id }), invalid);
  await assert.rejects(new EvidenceInspectionClient('http://127.0.0.1:1', 'synthetic').inspect('12345678-1234-1234-1234-123456789abc', { item: host.id }), error => error instanceof EvidenceInspectionError && error.code === 'unavailable');
  const markup = evidenceInspectionMarkup({ ...await inspectEvidence(host, { item: host.id }), rows: [] });
  assert.match(markup, /No citations/);
  // Producer output with literal markup remains text in the panel.
  await writeFile(path.join(host.root, 'markup.txt'), '<script>unsafe()</script>');
  await cite(host.id, 'markup.txt', { client: host.client, workspace: host.workspace, root: host.root, author: 'evidence-test', selector: { kind: 'lines', start: 1, end: 1 }, retain: true });
  const safe = evidenceInspectionMarkup(await inspectEvidence(host, { item: host.id, budget: 16000 }));
  assert.match(safe, /&lt;script&gt;/); assert.ok(!safe.includes('<script>'));
});

test('source policy admits linked JSON and legacy text, redacts unlinked originals, and discloses missing retained fragments', async t => {
  const host = await fixture(t);
  await writeFile(path.join(host.root, 'data.json'), '{"value":"unchanged"}');
  await cite(host.id, 'data.json', { client: host.client, workspace: host.workspace, root: host.root, author: 'evidence-test', selector: { kind: 'pointer', pointer: '/value' } });
  const json = await inspectEvidence(host, { item: host.id, budget: 16000 });
  assert.equal(json.rows[2].freshness, 'current'); assert.equal(json.rows[2].cited.reason, 'not-retained');
  const native = (await host.client.get(host.id, { full: true })).item;
  const legacy = JSON.parse(String(native.evidence_state)) as { citations: Array<{ criteria?: unknown }> };
  delete legacy.citations[0].criteria;
  await mutateItem({ pmRoot: host.workspace, settings: await readSettings(host.workspace), id: host.id, op: 'update', author: 'legacy-fixture', message: 'Seed prior citation shape and unlinked source', mutate(document) {
    document.metadata.evidence_state = JSON.stringify(legacy);
    document.metadata.files = document.metadata.files?.filter(file => file.path !== 'source-1.txt');
    return { changedFields: ['files', 'evidence_state'] };
  } });
  const page = await inspectEvidence(host, { item: host.id, budget: 16000 });
  assert.equal(page.rows[0].freshness, 'current'); assert.equal(page.rows[0].cited.text, 'original one');
  assert.equal(page.rows[1].code, 'boundary'); assert.equal(page.rows[1].source, null); assert.equal(page.rows[1].cited.text, null);
  assert.equal(page.rows[1].bindings.length, 0); assert.ok(!JSON.stringify(page).includes('original two'));
});
