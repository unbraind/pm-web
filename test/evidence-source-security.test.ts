import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mutateItem, readSettings } from '@unbrained/pm-cli/sdk';
import { bindCriterion, cite, criterionFacts, EvidenceError, type Selector } from 'pm-evidence';
import { inspectEvidence } from '../src/services/evidence-inspection.ts';
import { publicEvidenceSource, readApprovedEvidence, type EvidenceReadBarriers } from '../src/services/evidence-source.ts';
import { evidenceInspectionMarkup } from '../public/src/views/evidence-inspection.ts';
import { createPlainContractTracker } from './helpers/plain-contract-tracker.ts';

const PRIVATE = 'SYNTHETIC_PRIVATE_FIXTURE_BYTES';

test('every failed source lifecycle redacts retained and anchor copies without git while valid peers remain visible', async t => {
  const host = await fixture(t, 'Synthetic source binding');
  const options = { client: host.client, workspace: host.workspace, root: host.root, author: 'lifecycle-policy' };
  const examples: Array<{ selector: Selector; text: string }> = [
    { selector: { kind: 'lines', start: 1, end: 1 }, text: PRIVATE },
    { selector: { kind: 'heading', heading: 'Section', paragraph: 1 }, text: `## Section\n\n${PRIVATE}` },
    { selector: { kind: 'pointer', pointer: '/value' }, text: `{"value":"${PRIVATE}"}` },
  ];
  const failures = ['target-removed', 'directory-removed', 'chain-removed', 'alias-removed', 'public-removed', 'unreadable', 'oversize', 'invalid-utf8'] as const;
  let count = 0;
  for (const example of examples) for (const retain of [false, true]) for (const failure of failures) {
    const index = count++, directory = `.private-${index}`, target = path.join(host.root, directory, 'data.txt');
    const source = `source-${index}.txt`, alias = path.join(host.root, source);
    await mkdir(path.dirname(target)); await writeFile(target, example.text);
    if (failure === 'public-removed') await writeFile(alias, example.text);
    else if (failure === 'directory-removed') {
      await symlink(directory, path.join(host.root, `directory-${index}`));
      await symlink(`directory-${index}/data.txt`, alias);
    } else if (failure === 'chain-removed') {
      await symlink(`${directory}/data.txt`, path.join(host.root, `middle-${index}.txt`));
      await symlink(`middle-${index}.txt`, alias);
    } else await symlink(`${directory}/data.txt`, alias);
    const citation = await cite(host.item, source, { ...host, author: 'lifecycle-policy', selector: example.selector, retain });
    if (index === 0) {
      const facts = await criterionFacts([host.item], { ...options, record: false });
      await bindCriterion({ item: host.item, citation: citation.citation, criterion: { text: facts.rows[0].criterion, revision: facts.rows[0].revision! } }, options);
    }
    if (failure === 'directory-removed') await rm(path.dirname(target), { recursive: true });
    else if (failure === 'chain-removed') await rm(path.join(host.root, `middle-${index}.txt`));
    else if (failure === 'alias-removed' || failure === 'public-removed') await rm(alias);
    else if (failure === 'target-removed') await rm(target);
    else {
      // A public replacement tests failures beyond canonical-path denials.
      await rm(alias); await writeFile(alias, example.text);
      if (failure === 'unreadable') await chmod(alias, 0);
      else if (failure === 'oversize') await writeFile(alias, 'x'.repeat(262145));
      else await writeFile(alias, Buffer.from([0xff]));
    }
  }
  await writeFile(path.join(host.root, 'approved.txt'), 'public historical bytes');
  await cite(host.item, './approved.txt', { ...host, author: 'lifecycle-policy', selector: { kind: 'lines', start: 1, end: 1 }, retain: true });
  await writeFile(path.join(host.root, 'approved.txt'), 'public replacement bytes');
  const before = (await host.client.get(host.item, { full: true })).item;
  const settings = await readFile(path.join(host.workspace, 'settings.json'));
  await withoutGit(host.root, async () => {
    const rows = [];
    for (let offset = 0; offset <= count; offset += 20) {
      const page = await inspectEvidence(host, { item: host.item, offset, limit: 20, budget: 16000 });
      assert.ok(!JSON.stringify(page).includes(PRIVATE)); assert.ok(!evidenceInspectionMarkup(page).includes(PRIVATE));
      rows.push(...page.rows);
    }
    assert.equal(rows.length, count + 1);
    for (const row of rows.slice(0, count)) {
      assert.equal(row.cited.text, null, row.citation); assert.equal(row.current.text, null);
      assert.equal(row.cited.reason, 'not-allowed'); assert.equal(row.current.reason, 'not-allowed');
      assert.equal(row.source, null); assert.equal(row.selector, null); assert.deepEqual(row.bindings, []);
    }
    assert.equal(rows[count].cited.text, 'public historical bytes');
    assert.equal(rows[count].current.text, 'public replacement bytes'); assert.equal(rows[count].freshness, 'changed');
    assert.deepEqual((await host.client.get(host.item, { full: true })).item, before);
    assert.deepEqual(await readFile(path.join(host.workspace, 'settings.json')), settings);
  });
});

test('linked and canonical source operands share one reserved-name policy with legacy public aliases', () => {
  for (const prefix of ['', './', 'public/']) {
    for (const name of ['.env', '.private/data.json', 'auth.json', 'AUTH.JSON', 'node_modules/data.json', 'NODE_MODULES/data.json', 'credentials/data.json', 'Credentials.JSON', 'secret.txt', 'Secrets/data.json']) assert.equal(publicEvidenceSource(prefix + name), false);
    for (const name of ['source.txt', 'data.json', 'authentication.json', 'secretary.md', 'legacy-source.txt']) assert.equal(publicEvidenceSource(prefix + name), true);
  }
});
/** Create a real plain tracker; every private-looking filename below contains only an owned synthetic fixture. */
async function fixture(t: test.TestContext, acceptanceCriteria?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'evidence-object-policy-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const { client, pmRoot } = await createPlainContractTracker(root);
  const { item } = await client.create({ type: 'Task', title: 'Synthetic object authorization', acceptanceCriteria, unset: ['parent', 'assignee', 'sprint', 'release', 'goal', 'objective'] });
  return { root, workspace: pmRoot, client, item: item.id };
}
/** Execute native tracker reads with no Git executable or discoverable parent repository. */
async function withoutGit<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH, previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = root; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  try { return await operation(); }
  finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  }
}

test('all file/JSON and retained/unretained paths redact every copy of denied opened-source data', async t => {
  for (const pointer of [false, true]) for (const retain of [false, true]) {
    const host = await fixture(t);
    const content = `{"value":"${PRIVATE}"}`;
    const names = ['.env', '.config/private.json', '.agents/private.json', 'node_modules/private.json', 'credentials/private.json', 'secrets.json', 'auth.json'];
    const selector: Selector = pointer ? { kind: 'pointer', pointer: '/value' } : { kind: 'lines', start: 1, end: 1 };
    for (const [index, name] of names.entries()) {
      await mkdir(path.dirname(path.join(host.root, name)), { recursive: true });
      await writeFile(path.join(host.root, name), content);
      const source = `visible-${index}.txt`;
      await symlink(name, path.join(host.root, source));
      await cite(host.item, source, { ...host, author: 'synthetic-policy', selector, retain });
    }
    await symlink('.config', path.join(host.root, 'directory-alias'));
    await symlink('visible-0.txt', path.join(host.root, 'chained-alias.txt'));
    await link(path.join(host.root, '.env'), path.join(host.root, 'hard-alias.txt'));
    for (const source of ['directory-alias/private.json', 'chained-alias.txt', 'hard-alias.txt']) await cite(host.item, source, { ...host, author: 'synthetic-policy', selector, retain });
    const settings = await readFile(path.join(host.workspace, 'settings.json'));
    const page = await withoutGit(host.root, () => inspectEvidence(host, { item: host.item, limit: 20, budget: 16000 }));
    assert.equal(page.rows.length, 10);
    for (const row of page.rows) {
      assert.equal(row.code, 'boundary'); assert.equal(row.freshness, 'unknown');
      assert.equal(row.cited.text, null); assert.equal(row.current.text, null); assert.equal(row.selector, null);
    }
    assert.ok(!JSON.stringify(page).includes(PRIVATE));
    assert.ok(!evidenceInspectionMarkup(page).includes(PRIVATE));
    assert.deepEqual(await readFile(path.join(host.workspace, 'settings.json')), settings);
  }
});

test('opened-object policy preserves safe aliases and denies every synthetic alias swap boundary before publication', async t => {
  const host = await fixture(t), publicText = '{"value":"approved public bytes"}';
  await mkdir(path.join(host.root, 'public'));
  await mkdir(path.join(host.root, '.private'));
  await writeFile(path.join(host.root, 'public', 'data.json'), publicText);
  await writeFile(path.join(host.root, '.private', 'data.json'), `{"value":"${PRIVATE}"}`);
  await symlink('public', path.join(host.root, 'directory-alias'));
  await symlink('directory-alias/data.json', path.join(host.root, 'file-alias.json'));
  const context = { root: host.root, maxBytes: 262144, signal: new AbortController().signal };
  assert.equal((await readApprovedEvidence('file-alias.json', context)).text, publicText);
  const boundaries: (keyof EvidenceReadBarriers)[] = ['afterDiscovery', 'afterOpen', 'beforeRead', 'afterRead'];
  for (const boundary of boundaries) {
    let swapped = false;
    const barriers: EvidenceReadBarriers = { [boundary]: async () => {
      await rename(path.join(host.root, 'public'), path.join(host.root, 'held-public'));
      swapped = true;
      await symlink('.private', path.join(host.root, 'public'));
    } };
    try {
      const snapshot = await readApprovedEvidence('file-alias.json', context, barriers);
      assert.equal(snapshot.text, publicText); assert.ok(!snapshot.text.includes(PRIVATE));
    } catch (error) { assert.ok(error instanceof Error); assert.ok(!error.message.includes(PRIVATE)); }
    finally {
      if (swapped) {
        await rm(path.join(host.root, 'public'), { force: true });
        await rename(path.join(host.root, 'held-public'), path.join(host.root, 'public'));
      }
    }
    assert.equal((await readApprovedEvidence('file-alias.json', context)).text, publicText);
  }
  const selector: Selector = { kind: 'pointer', pointer: '/value' };
  await cite(host.item, './file-alias.json', { ...host, author: 'synthetic-policy', selector, retain: true });
  const page = await inspectEvidence(host, { item: host.item });
  assert.equal(page.rows[0].freshness, 'current'); assert.equal(page.rows[0].cited.text, '"approved public bytes"');
});

test('live JSON fragments remain available independently of cited retention and exact source spellings', async t => {
  const host = await fixture(t);
  const source = '{"escaped/key":{"~value":[9007199254740993,  1e309, "literal\\ntext"]},"__proto__":{"value":true}}';
  await writeFile(path.join(host.root, 'data.json'), source);
  const pointers = ['/escaped~1key/~0value/0', '/escaped~1key/~0value/1', '/escaped~1key/~0value/2', '/__proto__/value', ''];
  const expected = ['9007199254740993', '1e309', '"literal\\ntext"', 'true', source];
  for (const pointer of pointers) await cite(host.item, 'data.json', { ...host, author: 'fragment-test', selector: { kind: 'pointer', pointer } });
  const page = await inspectEvidence(host, { item: host.item, limit: 20, budget: 16000 });
  assert.deepEqual(page.rows.map(row => row.freshness), pointers.map(() => 'current'));
  assert.deepEqual(page.rows.map(row => row.cited.reason), pointers.map(() => 'not-retained'));
  assert.deepEqual(page.rows.map(row => row.current.text), expected);
});

test('all selectors resolve current bytes independently of missing or corrupt historical replay for current and changed sources', async t => {
  const host = await fixture(t);
  const cases: Array<{ selector: Selector; source: string; current: string; original: string; replacement: string }> = [
    { selector: { kind: 'lines', start: 2, end: 2 }, source: 'before\noriginal\nafter', current: 'before\nreplacement\nafter', original: 'original', replacement: 'replacement' },
    { selector: { kind: 'heading', heading: 'Section', paragraph: 1 }, source: '## Section\n\noriginal', current: '## Section\n\nreplacement', original: 'original', replacement: 'replacement' },
    { selector: { kind: 'pointer', pointer: '/value' }, source: '{"value":9007199254740993}', current: '{"value":1e309}', original: '9007199254740993', replacement: '1e309' },
  ];
  const expected: Array<{ freshness: string; text: string }> = [];
  let index = 0;
  for (const example of cases) for (const retention of ['absent', 'valid', 'corrupt']) for (const changed of [false, true]) {
    const name = `source-${index++}-${retention}.txt`;
    await writeFile(path.join(host.root, name), example.source);
    await cite(host.item, name, { ...host, author: 'history-independence', selector: example.selector, retain: retention !== 'absent' });
    if (changed) await writeFile(path.join(host.root, name), example.current);
    expected.push({ freshness: changed ? 'changed' : 'current', text: changed ? example.replacement : example.original });
  }
  const native = (await host.client.get(host.item, { full: true })).item;
  const state = JSON.parse(String(native.evidence_state)) as { citations: Array<{ descriptor: { source: string }; retained?: string }> };
  for (const citation of state.citations) if (citation.descriptor.source.includes('-corrupt.')) citation.retained = Buffer.from('invalid historical replay').toString('base64');
  await mutateItem({ pmRoot: host.workspace, settings: await readSettings(host.workspace), id: host.item, op: 'update', author: 'history-independence', message: 'Seed corrupt historical replay without changing live source facts', mutate(document) {
    document.metadata.evidence_state = JSON.stringify(state); return { changedFields: ['evidence_state'] };
  } });
  const before = (await host.client.get(host.item, { full: true })).item;
  const page = await inspectEvidence(host, { item: host.item, limit: 20, budget: 16000 });
  assert.deepEqual((await host.client.get(host.item, { full: true })).item, before);
  assert.deepEqual(page.rows.map(row => ({ freshness: row.freshness, text: row.current.text })), expected);
});

test('opened-source bounds and identity controls fail before publishing oversized, canceled, unreadable or changing bytes', async t => {
  const host = await fixture(t), source = path.join(host.root, 'bounded.txt');
  const context = { root: host.root, maxBytes: 16, signal: new AbortController().signal };
  await writeFile(source, 'approved');
  assert.equal((await readApprovedEvidence('bounded.txt', context)).text, 'approved');
  await assert.rejects(readApprovedEvidence('bounded.txt', { ...context, signal: AbortSignal.abort() }));
  await writeFile(source, 'x'.repeat(17));
  await assert.rejects(readApprovedEvidence('bounded.txt', context), error => error instanceof EvidenceError && error.code === 'size');
  await writeFile(source, 'approved');
  const originalMode = (await stat(source)).mode;
  try {
    await chmod(source, 0);
    await assert.rejects(readApprovedEvidence('bounded.txt', context), error => error instanceof EvidenceError && error.code === 'inaccessible');
  } finally { await chmod(source, originalMode); }
  for (const boundary of ['afterDiscovery', 'afterOpen', 'beforeRead', 'afterRead'] as const) {
    await writeFile(source, 'approved');
    await assert.rejects(readApprovedEvidence('bounded.txt', context, { [boundary]: () => writeFile(source, 'changed bytes') }), error => error instanceof EvidenceError && error.code === 'race');
    await writeFile(source, 'approved');
    const alias = path.join(host.root, 'hard-alias.txt');
    try {
      await assert.rejects(readApprovedEvidence('bounded.txt', context, { [boundary]: () => link(source, alias) }), error => error instanceof EvidenceError && error.code === 'boundary');
    } finally { await rm(alias, { force: true }); }
    assert.equal((await readApprovedEvidence('bounded.txt', context)).text, 'approved');
  }
  await assert.rejects(readApprovedEvidence('bounded.txt', context, { beforeRead: () => writeFile(source, 'x'.repeat(17)) }), error => error instanceof EvidenceError && error.code === 'size');
  await assert.rejects(readApprovedEvidence('.', context), error => error instanceof EvidenceError && error.code === 'boundary');
});

test('a missing public source preserves retained state but requires renewed authorization before display', async t => {
  const host = await fixture(t);
  await writeFile(path.join(host.root, 'public.txt'), 'historical public bytes');
  await cite(host.item, 'public.txt', { ...host, author: 'history-test', selector: { kind: 'lines', start: 1, end: 1 }, retain: true });
  const before = (await host.client.get(host.item, { full: true })).item;
  await rm(path.join(host.root, 'public.txt'));
  const page = await inspectEvidence(host, { item: host.item });
  assert.equal(page.rows[0].cited.text, null); assert.equal(page.rows[0].cited.reason, 'not-allowed');
  assert.equal(page.rows[0].current.text, null); assert.equal(page.rows[0].code, 'missing');
  assert.deepEqual((await host.client.get(host.item, { full: true })).item, before);
  await writeFile(path.join(host.root, 'public.txt'), 'historical public bytes');
  assert.equal((await inspectEvidence(host, { item: host.item })).rows[0].cited.text, 'historical public bytes');
});
