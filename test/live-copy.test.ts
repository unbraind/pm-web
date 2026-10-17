import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLiveUpdate, isOtherAuthor, liveFieldValue, liveCollectionMarkup, changedDraftFields } from '../public/src/live-copy.ts';
import { noteOwnItemEdit, isRecentOwnItemEdit } from '../public/src/edit-origin.ts';

const viewer = { id: 'viewer-id', email: 'viewer@example.test', display_name: 'Morgan' };

test('live origins prefer authenticated ids and never treat the current account or session as another author', () => {
  assert.equal(isOtherAuthor({ userId: viewer.id, author: 'Another name' }, viewer, 'session-a'), false);
  assert.equal(isOtherAuthor({ userId: 'other-id', author: 'Morgan' }, viewer, 'session-a'), true);
  assert.equal(isOtherAuthor({ sessionId: 'session-a', userId: 'other-id' }, viewer, 'session-a'), false);
  for (const author of ['Morgan', 'VIEWER@example.test', 'viewer-id']) assert.equal(isOtherAuthor({ author }, viewer, null), false);
  assert.equal(isOtherAuthor({ author: 'Alex' }, viewer, null), true);
  assert.equal(isOtherAuthor({}, viewer, null), false);
});

test('legacy and malformed SSE payloads remain safe and optional attribution is bounded', () => {
  for (const raw of ['null', '[]', 'false', '{bad']) assert.equal(parseLiveUpdate(raw), null);
  assert.deepEqual(parseLiveUpdate('{"itemId":"note-1","unrelated":true}'), { itemId: 'note-1' });
  assert.deepEqual(parseLiveUpdate(JSON.stringify({ author: 'x'.repeat(257), userId: 42, itemId: '  note-2  ' })), { itemId: 'note-2' });
});

test('local echo windows are item and project scoped and expire', () => {
  noteOwnItemEdit('/projects/project-a/pm/update/note-1', 100);
  assert.equal(isRecentOwnItemEdit('project-a', 'note-1', 101), true);
  assert.equal(isRecentOwnItemEdit('project-b', 'note-1', 101), false);
  assert.equal(isRecentOwnItemEdit('project-a', 'note-2', 101), false);
  assert.equal(isRecentOwnItemEdit('project-a', 'note-1', 5100), false);
  noteOwnItemEdit('/projects/project-a/pm/list', 5200);
  assert.equal(isRecentOwnItemEdit('project-a', 'note-1', 5200), false);
});

test('live readonly fields normalize aliases and escape user-supplied collection text', () => {
  const item = { id: 'note-3', title: 'A record', type: 'Bug', priority: 0, status: 'closed', acceptance_criteria: 'Prove the fix', 'blocked-reason': 'Needs a review' };
  assert.equal(liveFieldValue('strip', item), 'note-3 · Bug · P0');
  assert.equal(liveFieldValue('detailStatus', item), 'closed');
  assert.equal(liveFieldValue('acceptanceCriteria', item), 'Prove the fix');
  assert.equal(liveFieldValue('blockedReason', item), 'Needs a review');
  assert.equal(liveFieldValue('description', item), '');
  assert.match(liveCollectionMarkup('comments', [{ text: '<script>unsafe</script>' }]), /&lt;script&gt;/);
  assert.match(liveCollectionMarkup('history', []), /No history yet/);
});

test('saving a stale draft submits only changed fields so a remote title survives a description edit', () => {
  const baseline = { title: 'Earlier title', description: 'Earlier description', assignee: 'Morgan' };
  const draft = { ...baseline, description: 'My new description' };
  assert.deepEqual(changedDraftFields(baseline, draft), { description: 'My new description' });
  assert.deepEqual(changedDraftFields(baseline, baseline), {});
});
