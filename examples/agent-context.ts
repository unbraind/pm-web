/** Publish receipt metadata with explicit consent, retrieve its exact revision, then revoke it. */
import { AgentContextClient, coreContextEvidence } from '@unbrained/pm-web';
import type { PmReadOutputReceipt, PmReadOutputSessionReceipt } from '@unbrained/pm-cli/sdk';

/** Use actual receipts from a completed core SDK read; supply an authenticated account and audience. */
export async function inspectAgentContext(input: {
  url: string; token: string; project: string; viewer: string; sourceRevision: string;
  servedAt: string; session: PmReadOutputSessionReceipt; output: PmReadOutputReceipt;
}): Promise<void> {
  const client = new AgentContextClient(input.url, input.token);
  const packet = await client.publish(input.project, {
    agent: 'review-agent', question: 'Which evidence still needs review?', consent: true,
    viewers: [input.viewer],
    receipts: [coreContextEvidence(input.session, input.output, input.sourceRevision, input.servedAt)],
    gaps: [{ reason: 'Independent review pending', remedy: 'Review the exact revision before approval.' }],
  });
  const current = await client.get(input.project, packet.id, packet.revision);
  console.log(current.question, current.receipts, current.gaps);
  await client.revoke(input.project, packet.id, packet.revision);
}
