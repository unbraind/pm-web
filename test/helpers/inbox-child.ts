/** Exercise the built public SDK from a separate process with git absent from PATH. */
import { respondToDecision, requestDecision, listDecisionInbox, DecisionInboxError } from '../../dist/index.js';
import type { DecisionResponseInput, DecisionRequestInput } from '../../src/services/decision-inbox.ts';
const actor = { author: 'synthetic-agent', permission: 'edit' as const };
try {
  const action = process.argv[2];
  const root = process.argv[3];
  const input = JSON.parse(process.argv[4] ?? '{}') as DecisionResponseInput & DecisionRequestInput;
  const result = action === 'respond' ? await respondToDecision(root, actor, input) : action === 'request' ? await requestDecision(root, actor, input) : await listDecisionInbox(root);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  if (!(error instanceof DecisionInboxError)) throw error;
  process.stdout.write(JSON.stringify({ code: error.code, remedy: error.remedy }));
  process.exitCode = error.status === 409 ? 4 : 2;
}
