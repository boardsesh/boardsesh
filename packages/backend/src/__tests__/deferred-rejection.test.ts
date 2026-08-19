import { describe, expect, it } from 'vitest';

/**
 * The concurrency tests in board-merge-tombstone.test.ts and board-presence.test.ts
 * start a promise, then `await` something else before asserting on it. When the
 * started promise rejects during one of those intervening awaits, Node reaches its
 * unhandled-rejection checkpoint with no handler attached: vitest reports it under
 * `Errors` and the job exits 1 with every test passing (issue #4488, main run
 * 31880202330 — `test-backend (2, 2)`, 1712 tests passed, 1 error).
 *
 * The fix in both files is an inert `.catch()` attached at creation time. This file
 * pins the two properties that make it safe, with no database and no services:
 *
 *   1. the promise stays rejected, so the assertion further down still discriminates;
 *   2. the rejection survives an intervening await without leaking.
 *
 * The complementary evidence is the mutation probe recorded in the PR: with the
 * handler in place, changing the expected message in board-merge-tombstone.test.ts
 * makes the test fail. An inert guard that swallowed the rejection could not do that.
 */
function handleLater(promise: Promise<unknown>): void {
  void promise.catch((): void => undefined);
}

describe('handleLater', () => {
  it('leaves the promise rejected, so a later assertion still discriminates', async () => {
    const rejected = Promise.reject(new Error('Board not found'));
    handleLater(rejected);

    await expect(rejected).rejects.toThrow('Board not found');
    // The same handler must NOT make a wrong expectation pass. This is the
    // property that distinguishes it from swallowing the rejection.
    await expect(expect(rejected).rejects.toThrow('a message it never throws')).rejects.toThrow();
  });

  it('does not leak when the rejection lands during an intervening await', async () => {
    const leaks: string[] = [];
    const onUnhandled = (reason: unknown): void => {
      leaks.push(reason instanceof Error ? reason.message : String(reason));
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      // Same shape as the failing test: this rejects at ~10ms...
      const followPromise = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Board not found')), 10);
      });
      handleLater(followPromise);
      // ...while the test is suspended awaiting something that settles at ~30ms.
      const mergePromise = new Promise<void>((resolve) => setTimeout(resolve, 30));

      await mergePromise;
      await expect(followPromise).rejects.toThrow('Board not found');
      // Give Node's unhandled-rejection checkpoint room to fire if it were going to.
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      expect(leaks).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('resolves values through untouched', async () => {
    const resolved = Promise.resolve('survivor');
    handleLater(resolved);
    await expect(resolved).resolves.toBe('survivor');
  });
});
