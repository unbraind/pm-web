import assert from 'node:assert/strict';
import test from 'node:test';
import { FixtureResources } from './helpers/fixture-resources.ts';

test('resource ownership survives every acquisition and cleanup failure boundary', async t => {
  for (let failure = 0; failure <= 8; failure++) {
    const scope = new FixtureResources(t);
    const acquired: number[] = [], disposed: number[] = [];
    for (let index = 0; index < failure; index++) {
      await scope.acquire(async () => { acquired.push(index); return index; }, value => {
        disposed.push(value);
        if (value % 2 === 0) throw new Error('synthetic cleanup failure');
      });
    }
    await assert.rejects(scope.acquire(async () => { throw new Error('synthetic acquisition failure'); }, () => assert.fail('unacquired resource disposed')));
    await scope.close().catch(error => assert.ok(error instanceof AggregateError));
    assert.deepEqual(disposed, acquired.reverse());
    await scope.close();
    assert.equal(disposed.length, failure, 'no resource is disposed twice');
  }
});
