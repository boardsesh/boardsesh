import { describe, it, expect } from 'vitest';
import { combineAbortSignals, createTimeoutSignal, mapWithConcurrency } from '../abort-timeout';

describe('createTimeoutSignal', () => {
  it('aborts after the timeout', async () => {
    const signal = createTimeoutSignal(10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signal.aborted).toBe(true);
  });
});

describe('combineAbortSignals', () => {
  it('returns a signal that aborts when the first source aborts', () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const combined = combineAbortSignals(controllerA.signal, controllerB.signal);
    expect(combined.aborted).toBe(false);
    controllerA.abort(new Error('a'));
    expect(combined.aborted).toBe(true);
  });

  it('is already aborted if any source was aborted at construction time', () => {
    const controllerA = new AbortController();
    controllerA.abort();
    const controllerB = new AbortController();
    const combined = combineAbortSignals(controllerA.signal, controllerB.signal);
    expect(combined.aborted).toBe(true);
  });

  it('ignores undefined inputs', () => {
    const controllerA = new AbortController();
    const combined = combineAbortSignals(undefined, controllerA.signal, undefined);
    expect(combined.aborted).toBe(false);
    controllerA.abort();
    expect(combined.aborted).toBe(true);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order in the result array', async () => {
    const results = await mapWithConcurrency([10, 20, 30, 40, 50], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value));
      return value * 2;
    });
    expect(results).toEqual([20, 40, 60, 80, 100]);
  });

  it('caps in-flight calls at the given concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return null;
    });
    expect(maxActive).toBe(3);
  });

  it('throws the first error and lets siblings drain', async () => {
    const completed: number[] = [];
    const error = new Error('boom on index 2');

    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5], 3, async (value) => {
        await new Promise((resolve) => setTimeout(resolve, value * 2));
        if (value === 2) throw error;
        completed.push(value);
        return value;
      }),
    ).rejects.toThrow(error);

    // All non-error items should have completed (workers keep draining
    // after a sibling rejection).
    expect(completed.sort()).toEqual([0, 1, 3, 4, 5]);
  });

  it('reports the FIRST error when multiple items reject', async () => {
    const firstError = new Error('first');
    const secondError = new Error('second');

    await expect(
      mapWithConcurrency([0, 1, 2, 3], 1, async (value) => {
        if (value === 1) throw firstError;
        if (value === 2) throw secondError;
        return value;
      }),
    ).rejects.toBe(firstError);
  });

  it('distinguishes a thrown `undefined` from no error', async () => {
    await expect(
      mapWithConcurrency([0], 1, async () => {
        // Legal but unusual — a literally-undefined rejection should still
        // surface as a throw, not return a result.
        throw undefined;
      }),
    ).rejects.toBeUndefined();
  });

  it('returns immediately on empty input', async () => {
    const results = await mapWithConcurrency([], 4, async () => 'unreachable');
    expect(results).toEqual([]);
  });
});
