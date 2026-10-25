import { AgentContextClient } from '@unbrained/pm-web';

// Explicit operator-selected origin and session token; never persist packet contents.
const client = new AgentContextClient('https://pm.example.test', process.env.PM_WEB_TOKEN ?? '');
const project = 'project-uuid', id = 'packet-uuid', revision = 'reviewed-revision-uuid';
// Review the authorized question and its selected native items before admission.
const question = await client.get(project, id, revision);
console.log(question.question, question.items);
let packet = await client.resume(project, id, revision);
let acceptedCursor = packet.cursor; // Persist metadata only, after accepting the baseline.

// On reconnect: the same cursor is safe to retry until its event keys have been accepted.
do {
  packet = await client.resume(project, id, revision, acceptedCursor);
  for (const change of packet.changes) {
    console.log(change.item, change.version, change.operation, change.fields);
    // Fetch full native state through the authorized project SDK if the question needs it.
    // Bind any external side-effect idempotency key to change.key AND its target revision.
  }
  console.log(packet.receipt);
  acceptedCursor = packet.cursor; // Advance only after all returned references are accepted.
} while (!packet.receipt.complete);
