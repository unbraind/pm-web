import { rm } from 'node:fs/promises';
import type { TestContext } from 'node:test';

/** Register one teardown before setup, acquiring resources with immediate LIFO cleanup. */
export class FixtureResources {
  private readonly cleanups: Array<() => void | Promise<unknown>> = [];

  constructor(t?: Pick<TestContext, 'after'>) {
    t?.after(() => this.close());
  }

  /** Register restoration immediately after a synchronous state change. */
  defer(cleanup: () => void | Promise<unknown>): void {
    this.cleanups.push(cleanup);
  }

  /** Acquire one atomic resource and register disposal before returning it to setup. */
  async acquire<T>(create: () => Promise<T>, dispose: (value: T) => void | Promise<unknown>): Promise<T> {
    const value = await create();
    this.defer(() => dispose(value));
    return value;
  }

  /** Restore every acquired resource even when an earlier cleanup fails; repeat calls are safe. */
  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (let cleanup = this.cleanups.pop(); cleanup; cleanup = this.cleanups.pop()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed');
  }
}

/** Remove a root-only fixture when setup rejects before its cleanup handle can be returned. */
export async function failedFixtureSetup(root: string, error: unknown): Promise<never> {
  await rm(root, { recursive: true, force: true });
  throw error;
}
