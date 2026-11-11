/** Measure the delivered inspector on an immutable public fleet tracker, outside git. */
import { PmClient, certifyCompleteListResult } from '@unbrained/pm-cli/sdk';
import { inspectEvidence } from '../src/services/evidence-inspection.ts';
import { withPublicTrackerCopy } from './public-tracker-copy.ts';

const result = await withPublicTrackerCopy(async ({ cwd, pmRoot }) => {
  const start = performance.now(), client = new PmClient({ cwd, pmRoot, noExtensions: true });
  const corpus = certifyCompleteListResult(await client.listAllComplete({ includeBody: true }));
  let inspectedItems = 0, citationRows = 0, sourceReads = 0, maximumTokens = 0, refusals = 0;
  for (const item of corpus.items) {
    try {
      let offset: number | null = 0;
      do {
        const page = await inspectEvidence({ client, workspace: pmRoot, root: cwd }, { item: item.id, offset, budget: 16000 });
        citationRows += page.rows.length; sourceReads += page.sourceReads; maximumTokens = Math.max(maximumTokens, page.estimatedTokens); offset = page.nextOffset;
      } while (offset !== null);
      inspectedItems++;
    } catch { refusals++; }
  }
  return { repository: 'unbraind/pm-web', items: corpus.items.length, inspectedItems, citationRows, sourceReads, maximumTokens, refusals, elapsedMs: Math.round(performance.now() - start) };
});
console.log(JSON.stringify(result, null, 2));
