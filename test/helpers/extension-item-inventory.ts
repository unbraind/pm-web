/** Record real public-extension registrations in an isolated owner process before observational reads. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { activateExtensions, loadExtensions, readSettings } from '@unbrained/pm-cli/sdk';
import { describeExtensionActivation } from '@unbrained/pm-cli/sdk/testing';
import { createExtensionContributionInventory } from '@unbrained/pm-cli/sdk/authoring';

const cwd = process.argv[2];
assert.ok(cwd, 'A synthetic workspace is required');
const pmRoot = path.join(cwd, '.agents', 'pm');
const loaded = await loadExtensions({ pmRoot, cwd, settings: await readSettings(pmRoot), ignoreGlobalExtensions: true });
const activated = await activateExtensions(loaded);
assert.deepEqual(activated.failed, []);
const inventory = createExtensionContributionInventory(describeExtensionActivation(activated, { extensionName: 'pm-graph' }));
assert.deepEqual(inventory.item_types, [], 'the published graph package contributes fields and relationships, not item types');
process.stdout.write(JSON.stringify(inventory));
