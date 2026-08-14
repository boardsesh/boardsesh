// The retry ladder's contract (issue #4315). Every assertion here is something
// a caller depends on: the silence on a clean write (the event's count is the
// contention rate), the identity-preserving rethrow (Sentry grouping), and the
// budget gating retries but never attempt 1.
//
// Clock and sleep are injected, so no fake timers and no real waiting.

import { describe, it, expect, vi } from 'vitest';
import { runLocalWriteWithRetry, OFFLINE_LOCAL_WRITE_BUDGET_MS } from '../write-retry';

const LOCK_ERROR = () => new Error('Error code 5: database is locked');
const DISK_ERROR = () => new Error('database or disk is full');

/** A clock that advances by `stepMs` on every read, so elapsed time is exact. */
function steppingClock(stepMs: number) {
  let value = 0;
  return () => {
    const current = value;
    value += stepMs;
    return current;
  };
}

describe('runLocalWriteWithRetry', () => {
  it('returns the write value and reports nothing when the first attempt succeeds', async () => {
    const onSettled = vi.fn();
    const write = vi.fn().mockResolvedValue('saved');

    await expect(runLocalWriteWithRetry(write, { onSettled })).resolves.toBe('saved');

    expect(write).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('passes the 1-based attempt number to the write', async () => {
    const attempts: number[] = [];
    await runLocalWriteWithRetry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt === 1) throw LOCK_ERROR();
      },
      { sleep: async () => {} },
    );

    expect(attempts).toEqual([1, 2]);
  });

  it('retries a lock error and reports a recovery', async () => {
    const onSettled = vi.fn();
    const write = vi.fn().mockRejectedValueOnce(LOCK_ERROR()).mockResolvedValue('second');

    await expect(runLocalWriteWithRetry(write, { onSettled, sleep: async () => {} })).resolves.toBe('second');

    expect(write).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0][0]).toMatchObject({ attempts: 2, recovered: true });
  });

  it('does not retry a non-lock error', async () => {
    const onSettled = vi.fn();
    const write = vi.fn().mockRejectedValue(DISK_ERROR());

    await expect(runLocalWriteWithRetry(write, { onSettled, sleep: async () => {} })).rejects.toThrow(
      'database or disk is full',
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0][0]).toMatchObject({ attempts: 1, recovered: false });
  });

  it('rethrows after exhausting maxAttempts and reports the exhaustion', async () => {
    const onSettled = vi.fn();
    const write = vi.fn().mockRejectedValue(LOCK_ERROR());

    await expect(runLocalWriteWithRetry(write, { onSettled, sleep: async () => {} })).rejects.toThrow(
      'database is locked',
    );

    expect(write).toHaveBeenCalledTimes(2);
    expect(onSettled.mock.calls[0][0]).toMatchObject({ attempts: 2, recovered: false });
  });

  it('rethrows the SAME error object, so Sentry grouping and lock classification are unchanged', async () => {
    const thrown = DISK_ERROR();
    const caught = await runLocalWriteWithRetry(async () => {
      throw thrown;
    }).catch((error: unknown) => error);

    expect(caught).toBe(thrown);
  });

  it('sleeps the retry delay between attempts', async () => {
    const sleep = vi.fn(async () => {});
    const write = vi.fn().mockRejectedValueOnce(LOCK_ERROR()).mockResolvedValue(null);

    await runLocalWriteWithRetry(write, { retryDelayMs: 150, sleep });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(150);
  });

  it('still runs attempt 1 with a zero budget, and does not retry', async () => {
    const write = vi.fn().mockRejectedValue(LOCK_ERROR());
    const sleep = vi.fn(async () => {});

    await expect(runLocalWriteWithRetry(write, { budgetMs: 0, sleep })).rejects.toThrow('database is locked');

    expect(write).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops on the budget rather than on maxAttempts once the clock has run out', async () => {
    // 5s per clock read: the first budget check sits at 5s (a retry still fits),
    // the second at 10s (it does not) — so four allowed attempts yield two.
    const write = vi.fn().mockRejectedValue(LOCK_ERROR());
    const sleep = vi.fn(async () => {});

    await expect(runLocalWriteWithRetry(write, { maxAttempts: 4, now: steppingClock(5000), sleep })).rejects.toThrow(
      'database is locked',
    );

    expect(write).toHaveBeenCalledTimes(2);
  });

  it('reports elapsedMs from the injected clock', async () => {
    const onSettled = vi.fn();
    const write = vi.fn().mockRejectedValueOnce(LOCK_ERROR()).mockResolvedValue(null);

    await runLocalWriteWithRetry(write, { onSettled, now: steppingClock(100), sleep: async () => {} });

    // Reads: start=0, budget check=100, settle=200.
    expect(onSettled.mock.calls[0][0].elapsedMs).toBe(200);
  });

  it('does not let a throwing onSettled change the outcome', async () => {
    const onSettled = vi.fn(() => {
      throw new Error('analytics exploded');
    });

    await expect(
      runLocalWriteWithRetry(vi.fn().mockRejectedValueOnce(LOCK_ERROR()).mockResolvedValue('ok'), {
        onSettled,
        sleep: async () => {},
      }),
    ).resolves.toBe('ok');

    await expect(
      runLocalWriteWithRetry(vi.fn().mockRejectedValue(DISK_ERROR()), { onSettled, sleep: async () => {} }),
    ).rejects.toThrow('database or disk is full');
  });

  it('honours a custom shouldRetry over the lock-error default', async () => {
    const write = vi.fn().mockRejectedValueOnce(DISK_ERROR()).mockResolvedValue('retried anyway');

    await expect(runLocalWriteWithRetry(write, { shouldRetry: () => true, sleep: async () => {} })).resolves.toBe(
      'retried anyway',
    );
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('caps the default budget at nine seconds', () => {
    expect(OFFLINE_LOCAL_WRITE_BUDGET_MS).toBe(9000);
  });
});
