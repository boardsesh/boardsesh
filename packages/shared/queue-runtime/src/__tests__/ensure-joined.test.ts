import { describe, it, expect, vi } from 'vitest';
import { createJoinSessionTracker } from '../ensure-joined';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('createJoinSessionTracker', () => {
  it('fires execute once per (sessionId, epoch) and caches the result', async () => {
    const execute = vi.fn(async (_vars: { sessionId: string; boardPath: string }) => {});
    const getBoardPath = vi.fn(async () => '/kilter/1/2/3/40');
    const tracker = createJoinSessionTracker({ execute, getBoardPath });

    await tracker.ensureJoined('s1');
    await tracker.ensureJoined('s1');
    await tracker.ensureJoined('s1');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ sessionId: 's1', boardPath: '/kilter/1/2/3/40' });
  });

  it('shares an in-flight promise across concurrent callers', async () => {
    const ack = deferred<void>();
    const execute = vi.fn(async () => {
      await ack.promise;
    });
    const tracker = createJoinSessionTracker({
      execute,
      getBoardPath: async () => '/kilter/1/2/3/40',
    });

    const a = tracker.ensureJoined('s1');
    const b = tracker.ensureJoined('s1');
    const c = tracker.ensureJoined('s1');

    // Drain microtasks so getBoardPath resolves and execute kicks off.
    await Promise.resolve();
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);

    ack.resolve();
    await Promise.all([a, b, c]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fires a fresh execute after bumpEpoch invalidates the cache', async () => {
    const execute = vi.fn(async () => {});
    const tracker = createJoinSessionTracker({
      execute,
      getBoardPath: async () => '/kilter/1/2/3/40',
    });

    await tracker.ensureJoined('s1');
    expect(execute).toHaveBeenCalledTimes(1);

    tracker.bumpEpoch();
    await tracker.ensureJoined('s1');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('fires a fresh execute when sessionId changes', async () => {
    const execute = vi.fn(async () => {});
    const tracker = createJoinSessionTracker({
      execute,
      getBoardPath: async () => '/kilter/1/2/3/40',
    });

    await tracker.ensureJoined('s1');
    await tracker.ensureJoined('s2');

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0].sessionId).toBe('s1');
    expect(execute.mock.calls[1][0].sessionId).toBe('s2');
  });

  it('clears the cache on failure so the next call retries', async () => {
    let fail = true;
    const execute = vi.fn(async () => {
      if (fail) throw new Error('socket flake');
    });
    const tracker = createJoinSessionTracker({
      execute,
      getBoardPath: async () => '/kilter/1/2/3/40',
    });

    await expect(tracker.ensureJoined('s1')).rejects.toThrow('socket flake');
    fail = false;
    await tracker.ensureJoined('s1');

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('throws when getBoardPath resolves to null', async () => {
    const execute = vi.fn(async () => {});
    const tracker = createJoinSessionTracker({
      execute,
      getBoardPath: async () => null,
    });

    await expect(tracker.ensureJoined('s1')).rejects.toThrow(/Board path unavailable/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('reset() clears cache without bumping the epoch — but cache entry from prior epoch still becomes invalid after reset', async () => {
    const execute = vi.fn(async () => {});
    const tracker = createJoinSessionTracker({
      execute,
      getBoardPath: async () => '/kilter/1/2/3/40',
    });

    await tracker.ensureJoined('s1');
    expect(execute).toHaveBeenCalledTimes(1);

    tracker.reset();
    await tracker.ensureJoined('s1');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('bumpEpoch mid-flight does not double-clear a cache entry the failure path also tries to clear', async () => {
    // Race: ensureJoined kicks off, mid-flight bumpEpoch nulls cached, then
    // execute rejects. The catch block must not try to clear a stale entry.
    let rejectFirst!: (err: unknown) => void;
    let callCount = 0;
    const execute = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        await new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      // Subsequent calls resolve immediately.
    });
    const tracker = createJoinSessionTracker({
      execute,
      getBoardPath: async () => '/kilter/1/2/3/40',
    });

    const inFlight = tracker.ensureJoined('s1');
    // Yield enough microtasks for the inner IIFE to traverse getBoardPath
    // and hit `await execute(...)` so rejectFirst is assigned.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    tracker.bumpEpoch();
    rejectFirst(new Error('disconnected'));

    await expect(inFlight).rejects.toThrow('disconnected');

    // Next ensureJoined fires fresh at the new epoch.
    await tracker.ensureJoined('s1');
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
