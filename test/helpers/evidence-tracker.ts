import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bindCriterion, cite, criterionFacts } from 'pm-evidence';
import { createPlainContractTracker } from './plain-contract-tracker.ts';

/** Seed native fields, relationships and producer-owned evidence in a genuine non-git SDK tracker. */
export async function evidenceTracker(root: string) {
  const { client, pmRoot } = await createPlainContractTracker(root);
  const parent = await client.create({ type: 'Task', title: 'Context parent', unset: ['parent', 'assignee', 'sprint', 'release', 'goal', 'objective'] });
  const { item } = await client.create({ type: 'Task', title: 'Inspect sources', description: 'Native body \r\n with whitespace  ', acceptanceCriteria: 'First source remains current; Second source remains current', parent: parent.item.id, priority: 2, tags: 'native,preserve', body: 'Native markdown\n\nKeep relationships.', unset: ['assignee', 'sprint', 'release', 'goal', 'objective'] });
  const texts = ['before one\noriginal one\nafter one', 'before two\noriginal two\nafter two'];
  const options = { client, workspace: pmRoot, root, author: 'evidence-test' };
  const citations = [];
  for (let index = 0; index < texts.length; index++) {
    await writeFile(path.join(root, `source-${index}.txt`), texts[index]);
    citations.push(await cite(item.id, `source-${index}.txt`, { ...options, selector: { kind: 'lines', start: 2, end: 2 }, retain: true }));
  }
  const facts = await criterionFacts([item.id], { ...options, record: false, budget: 16000 });
  for (let index = 0; index < citations.length; index++) await bindCriterion({ item: item.id, citation: citations[index].citation, criterion: { text: facts.rows[index].criterion, revision: facts.rows[index].revision! } }, options);
  return { client, workspace: pmRoot, root, id: item.id, texts, citations };
}
