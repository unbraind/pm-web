import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, mkdir, symlink, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import { startEphemeralServer } from './helpers/ephemeral-server.ts';
import { isPmCliExpectedError, type ContractsResult } from '@unbrained/pm-cli/sdk';
import { createExtensionTestHarness } from '@unbrained/pm-cli/sdk/testing';
import extension from '../src/index.ts';
import { createPlainContractTracker } from './helpers/plain-contract-tracker.ts';
import { ContractExplorerError, contractPageNumber, directoryContractAdapter, exploreContracts, reviewContract, type ContractAdapter } from '../src/contract-explorer.ts';
import { ContractExplorerClient } from '../src/contract-explorer-client.ts';
import { contractExplorerMarkup } from '../public/src/views/contract-explorer.ts';
import { installExtension } from './helpers/install-runtime-extension.ts';
const exec = promisify(execFile);
/** Initialize a genuine tracker outside Git; inspect through the same SDK used in production. */
async function fixture(t: TestContext) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'contract-plain-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const { pmRoot, client } = await createPlainContractTracker(cwd);
  const { item } = await client.create({ type: 'Task', title: 'Preserve this item', description: 'A synthetic preservation fixture.' });
  const adapter = directoryContractAdapter({ cwd, pmRoot, noExtensions: true });
  return { cwd, pmRoot, client, item, adapter };
}
/** Require a machine-readable refusal and safe recovery text. */
function refusal(code: ContractExplorerError['code']) { return (error: unknown) => error instanceof ContractExplorerError && error.code === code && error.remedy.length > 10; }
/** Read durable tracker bytes, excluding SDK-owned transient read caches. */
async function durableFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (['runtime', 'search', 'locks', 'extensions'].includes(entry.name)) continue;
    const name = path.join(root, entry.name);
    if (entry.isDirectory()) for (const [key, value] of Object.entries(await durableFiles(name))) files[`${entry.name}/${key}`] = value;
    else files[entry.name] = await readFile(name, 'utf8');
  }
  return files;
}

test('SDK paginates every live core operation and review leaves durable tracker bytes unchanged', async t => {
  const f = await fixture(t), before = await durableFiles(f.pmRoot);
  const first = await exploreContracts(f.adapter, { limit: 5 });
  assert.equal(first.operations.length, 5); assert.equal(first.nextOffset, 5); assert.ok(first.total > 50);
  const actions = new Set<string>();
  for (let offset: number | null = 0; offset !== null;) { const page = await exploreContracts(f.adapter, { offset, limit: 50 }); page.operations.forEach(row => { assert.ok(!actions.has(row.action)); actions.add(row.action); }); offset = page.nextOffset; }
  assert.equal(actions.size, first.total); assert.ok(actions.has('delete')); assert.ok(actions.has('schema'));
  const selected = await exploreContracts(f.adapter, { action: 'delete' }); assert.ok(selected.schema); assert.equal(selected.operations[0].mutation, true);
  const preview = await reviewContract(f.adapter, 'delete', { id: f.item.id }, 'edit');
  assert.equal(preview.executed, false); assert.equal(preview.validated, false); assert.equal(preview.input.id, f.item.id);
  assert.deepEqual(await durableFiles(f.pmRoot), before);
  assert.equal((await exploreContracts(f.adapter, { offset: first.total + 1 })).operations.length, 0);
  await assert.rejects(reviewContract(f.adapter, 'delete', {}, 'view'), refusal('view_only'));
  assert.equal((await reviewContract(f.adapter, 'list', {}, 'view')).executed, false);
  await assert.rejects(exploreContracts(f.adapter, { action: 'not-an-operation' }), refusal('unsupported'));
});

test('synthetic provider declarations fail closed and produce identical escaped rows across backend kinds', async t => {
  const { adapter } = await fixture(t), snapshot = await adapter.describe({ availabilityOnly: true });
  const original = snapshot.action_availability!.find(row => row.action === 'delete')!;
  for (const status of ['available', 'unsupported', 'unavailable'] as const) {
    const row = { ...original, command_path: '<img src=x onerror=alert(1)>', available: status === 'available', invocable: status === 'available', requires_extension: status === 'unsupported' };
    const source = { ...snapshot, action_availability: [row] };
    const html: string[] = [];
    for (const kind of ['directory', 'postgres', 'remote'] as const) {
      const provider: ContractAdapter = { kind, describe: async () => source };
      const page = await exploreContracts(provider); assert.equal(page.operations[0].status, status);
      const markup = contractExplorerMarkup(page, true); html.push(markup.replace(kind, 'backend'));
      assert.match(markup, /&lt;img/); assert.doesNotMatch(markup, /<img/);
      assert.equal(/disabled/.test(markup), status !== 'available');
      if (status !== 'available') await assert.rejects(reviewContract(provider, 'delete', {}, 'edit'), refusal(status));
      assert.match(contractExplorerMarkup(page, false), /disabled/);
    }
    assert.equal(new Set(html).size, 1);
  }
  const unavailable: ContractAdapter = { kind: 'remote', describe: async () => { throw new Error('credential-shaped-private-diagnostic'); } };
  await assert.rejects(exploreContracts(unavailable), error => refusal('unavailable')(error) && !String(error).includes('private-diagnostic'));
  for (const action_availability of [undefined, [{ ...original, invocable: undefined }], [original, original]]) {
    await assert.rejects(exploreContracts({ kind: 'postgres', describe: async () => ({ ...snapshot, action_availability }) as ContractsResult }), refusal('unavailable'));
  }
});

test('strict SDK and transport inputs reject ambiguous pagination and oversized or cyclic envelopes', async t => {
  const { adapter, pmRoot } = await fixture(t);
  for (const options of [{ offset: -1 }, { limit: 0 }, { limit: 51 }, { offset: 0.1 }, { action: '' }, { action: 'x'.repeat(161) }]) await assert.rejects(exploreContracts(adapter, options), refusal('invalid_input'));
  for (const value of ['', ' ', null, false, [], ['0'], {}, '1e2', '1.2', Infinity]) assert.throws(() => contractPageNumber(value), refusal('invalid_input'));
  assert.equal(contractPageNumber(undefined), undefined); assert.equal(contractPageNumber('10'), 10); assert.equal(contractPageNumber(0), 0);
  for (const input of [null, [], '', { text: 'x'.repeat(12289) }]) await assert.rejects(reviewContract(adapter, 'delete', input, 'edit'), refusal('invalid_input'));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  await assert.rejects(reviewContract(adapter, 'delete', cyclic, 'edit'), refusal('invalid_input'));
  await rm(pmRoot, { recursive: true }); await assert.rejects(exploreContracts(adapter), refusal('unavailable'));
  await assert.rejects(exploreContracts(directoryContractAdapter({})), refusal('unavailable'));
});

test('native CLI supports JSON and TOON with no Git executable and exposes typed refusals', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await installExtension(f.pmRoot, f.client, 'pm-web', 'dist/index.js', ['commands', 'schema']);
  const host = await createExtensionTestHarness(extension, { name: 'pm-web', capabilities: ['commands', 'schema'] }); t.after(() => host.deactivate());
  for (const options of [{ input: '{', action: 'delete' }, { input: '{}' }, { limit: '' }, { limit: '99' }]) await assert.rejects(host.runCommand({ command: 'web contracts', pmRoot: f.pmRoot, options }), isPmCliExpectedError);
  const bin = path.join(f.cwd, 'bin'); await mkdir(bin); await symlink(process.execPath, path.join(bin, 'node'));
  const env = { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: path.dirname(f.cwd), PM_AUTHOR: 'contract-test' };
  const cli = path.resolve('node_modules/@unbrained/pm-cli/dist/cli.js');
  const invoke = (args: string[]) => exec(process.execPath, [cli, '--pm-path', f.pmRoot, 'web', 'contracts', ...args], { cwd: f.cwd, env });
  const json = await invoke(['--limit', '2', '--json']); assert.equal(JSON.parse(json.stdout).operations.length, 2); assert.ok(Buffer.byteLength(json.stdout) < 2500);
  const toon = await invoke(['--limit', '2']); assert.match(toon.stdout, /review_only/); assert.match(toon.stdout, /nextOffset: 2/);
  const preview = await invoke(['--action', 'delete', '--input', JSON.stringify({ id: f.item.id }), '--json']); assert.equal(JSON.parse(preview.stdout).executed, false);
  await assert.rejects(invoke(['--action', 'not-an-operation', '--json']), error => { const result = error as { stdout: string; stderr: string; code: number }; assert.notEqual(result.code, 0); assert.match(result.stdout + result.stderr, /unsupported/); return true; });
  assert.equal((await f.client.get(f.item.id)).item.id, f.item.id);
});

test('remote SDK refuses unsafe origins and sanitizes unreachable or malformed responses', async () => {
  for (const url of ['invalid', 'http://example.test', 'https://secret@example.test', 'https://example.test/path', 'https://example.test?token=x']) assert.throws(() => new ContractExplorerClient(url, 'synthetic'), refusal('invalid_input'));
  assert.ok(new ContractExplorerClient('https://example.test', 'synthetic'));
  await assert.rejects(new ContractExplorerClient('http://127.0.0.1:1', 'synthetic').list('scope'), refusal('unavailable'));
});

/** Use real loopback HTTP to cover malformed transport and server refusals without mocking fetch or the SDK. */
test('remote transport preserves typed errors and refuses redirects and malformed responses', async t => {
  const app = express(); app.use(express.json()); let mode = 'missing';
  app.use((_req, res) => {
    if (mode === 'missing') res.status(404).json({ code: 'not_found', remedy: 'Select a shared project.' });
    else if (mode === 'bare') res.status(503).json({});
    else if (mode === 'redirect') res.redirect('https://example.test');
    else res.status(200).send('not-json');
  });
  const server = await startEphemeralServer(app); t.after(() => server.close());
  const client = new ContractExplorerClient(server.url('/'), 'synthetic');
  await assert.rejects(client.list('scope'), refusal('not_found'));
  mode = 'bare'; await assert.rejects(client.review('scope', 'delete', {}), refusal('unavailable'));
  for (const next of ['redirect', 'invalid']) { mode = next; await assert.rejects(client.list('scope'), refusal('unavailable')); }
});
