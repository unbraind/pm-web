/** Measure actual core receipts from an immutable public tracker copy outside git. */
import { listAllComplete, PmClient, type PmReadOutputReceipt, type PmReadOutputSessionReceipt } from '@unbrained/pm-cli/sdk';
import { coreContextEvidence } from '../src/agent-context.ts';
import { validateAgentContext } from '../src/services/agent-context.ts';
import { withPublicTrackerCopy } from './public-tracker-copy.ts';

const result = await withPublicTrackerCopy(async ({ cwd, pmRoot, source }) => {
  const start = performance.now();
  const corpus = await listAllComplete({}, { pmRoot, cwd, noExtensions: true });
  const client = new PmClient({ pmRoot, cwd, noExtensions: true });
  const result = await client.list({ limit: '20', outputBudget: 1600, outputSession: { version: 1, id: 'public-fleet-read', token_budget: 4000, spent_tokens: 0, seen_item_ids: corpus.items.slice(0, 3).map(item => item.id) } }) as { items: { id: string }[]; read_session: PmReadOutputSessionReceipt; read_output: PmReadOutputReceipt };
  const receipt = coreContextEvidence(result.read_session, result.read_output, source, '2026-10-23T00:00:00Z');
  const packet = validateAgentContext({ agent: 'public-audit-agent', question: 'Which source evidence was omitted from this bounded public tracker read?', consent: true, viewers: [], receipts: [receipt], gaps: [{ reason: 'Independent review is outside this read', remedy: 'Read the source review evidence separately.' }] });
  const elapsedMs = Math.round(performance.now() - start);
  return { repository: 'unbraind/pm-web', items: corpus.items.length, returnedRows: result.items?.length ?? 0, suppressedRepeats: result.read_session.suppressed_repeat_count, sourceEstimatedTokens: result.read_output.estimated_tokens, sourceWithinBudget: result.read_output.within_budget, receiptOmissions: receipt.omission.length, unresolvedGaps: packet.gaps.length, packetJsonBytes: Buffer.byteLength(JSON.stringify(packet)), elapsedMs };
});
console.log(JSON.stringify(result, null, 2));
