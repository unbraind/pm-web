/** Run with node examples/decision-inbox.ts; creates and removes an isolated non-git tracker. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { listDecisionInbox, requestDecision, respondToDecision } from '../dist/index.js';

const cwd = await mkdtemp(path.join(os.tmpdir(), 'pm-decision-example-'));
try {
  const pmRoot = path.join(cwd, '.agents', 'pm');
  const client = new PmClient({ cwd, pmRoot, noExtensions: true });
  await client.init('example', { defaults: true, agentGuidance: 'skip' });
  const plan = await client.planCreate({ title: 'Choose project storage' });
  const actor = { author: 'example-editor', permission: 'edit' as const };
  const request = await requestDecision(pmRoot, actor, {
    planId: plan.plan.id,
    question: 'Which storage approach should implementation follow?',
    alternatives: ['Local files', 'Shared database'],
    evidence: 'Synthetic comparison: local simplicity versus coordinated remote access.',
  });
  console.log(await listDecisionInbox(pmRoot, { limit: 5 }));
  const acknowledgment = await respondToDecision(pmRoot, actor, { planId: request.planId, requestId: request.id, revision: request.revision, action: 'acknowledge', reason: 'Evidence read; checking access requirements.' });
  console.log(await respondToDecision(pmRoot, actor, {
    planId: request.planId, requestId: request.id, revision: acknowledgment.request.revision,
    action: 'approve', alternative: 1, reason: 'Multiple remote clients require shared access.',
  }));
} finally {
  await rm(cwd, { recursive: true, force: true });
}
