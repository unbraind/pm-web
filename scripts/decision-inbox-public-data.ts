/** Measure real decision requests from an immutable non-git copy of the public tracker. */
import { listAllComplete } from '@unbrained/pm-cli/sdk';
import { listDecisionInbox } from '../src/services/decision-inbox.ts';
import { withPublicTrackerCopy } from './public-tracker-copy.ts';

const result = await withPublicTrackerCopy(async ({ cwd: root, pmRoot }) => {
  const started = performance.now();
  const corpus = await listAllComplete({}, { pmRoot, cwd: root, noExtensions: true });
  const page = await listDecisionInbox(pmRoot, { limit: 20 });
  const elapsedMs = Math.round(performance.now() - started);
  return { repository: 'unbraind/pm-web', items: corpus.items.length, plans: corpus.items.filter(item => item.type === 'Plan').length, coreDecisions: corpus.items.filter(item => item.type === 'Decision').length, pendingRequests: page.total, returned: page.requests.length, jsonBytes: Buffer.byteLength(JSON.stringify(page)), elapsedMs };
});
console.log(JSON.stringify(result, null, 2));
