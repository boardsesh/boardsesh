import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';

import { resetSingleFlightForTests, singleFlight } from '../single-flight';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetSingleFlightForTests();
});

describe('singleFlight', () => {
  it('runs once for callers that arrive while the first is still in flight', async () => {
    const gate = deferred<string>();
    const run = vi.fn(() => gate.promise);

    const joined = [singleFlight('k', run), singleFlight('k', run), singleFlight('k', run)];
    // The whole point: three callers, one statement, one pool connection.
    expect(run).toHaveBeenCalledTimes(1);

    gate.resolve('configs');
    expect(await Promise.all(joined)).toEqual(['configs', 'configs', 'configs']);
  });

  it('does not serve a settled result to the next caller', async () => {
    const run = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');

    expect(await singleFlight('k', run)).toBe('first');
    expect(await singleFlight('k', run)).toBe('second');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keys are independent', async () => {
    const gateA = deferred<string>();
    const gateB = deferred<string>();
    const runA = vi.fn(() => gateA.promise);
    const runB = vi.fn(() => gateB.promise);

    const pendingA = singleFlight('a', runA);
    const pendingB = singleFlight('b', runB);
    gateA.resolve('A');
    gateB.resolve('B');

    expect(await pendingA).toBe('A');
    expect(await pendingB).toBe('B');
  });

  it('propagates a rejection to every joined caller and forgets it', async () => {
    const gate = deferred<string>();
    const run = vi.fn(() => gate.promise);

    const first = singleFlight('k', run);
    const second = singleFlight('k', run);
    gate.reject(new Error('pool gone'));

    await expect(first).rejects.toThrow('pool gone');
    await expect(second).rejects.toThrow('pool gone');

    // A failed read must not poison the key — the next caller retries.
    const retry = vi.fn().mockResolvedValue('recovered');
    expect(await singleFlight('k', retry)).toBe('recovered');
  });

  it('clears the key when the runner throws synchronously', async () => {
    const throwing = vi.fn(() => {
      throw new Error('sync boom');
    });

    await expect(singleFlight('k', throwing as unknown as () => Promise<string>)).rejects.toThrow('sync boom');

    const retry = vi.fn().mockResolvedValue('ok');
    expect(await singleFlight('k', retry)).toBe('ok');
  });
});
