import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOtaOperationOwner } from '../ota-operation-owner';

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe('OTA operation ownership', () => {
  it('retains ownership until timed-out native work settles before restoring', async () => {
    vi.useFakeTimers();
    const owner = createOtaOperationOwner();
    const native = deferred<void>();
    const phases: string[] = [];
    const first = owner.run(
      async (lease) => {
        phases.push('pin');
        try {
          await lease.native(() => native.promise);
          phases.push('reload');
        } finally {
          phases.push('restore');
        }
      },
      { timeoutMs: 10 },
    );
    const timedOut = expect(first).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(10);
    await timedOut;
    const second = owner.run(async () => {
      phases.push('second');
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(phases).toEqual(['pin']);
    native.resolve();
    await second;
    expect(phases).toEqual(['pin', 'restore', 'second']);
  });

  it('expires queued callbacks without invoking them', async () => {
    vi.useFakeTimers();
    const owner = createOtaOperationOwner();
    const native = deferred<void>();
    const first = owner.run((lease) => lease.native(() => native.promise));
    const callback = vi.fn(async () => {});
    const queued = owner.run(callback, { timeoutMs: 10 });
    const rejection = expect(queued).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    native.resolve();
    await first;
    await owner.run(async () => {});
    expect(callback).not.toHaveBeenCalled();
  });

  it('keeps headers held after caller abort until native failure settles', async () => {
    const owner = createOtaOperationOwner();
    const native = deferred<void>();
    const controller = new AbortController();
    const started = deferred<void>();
    const restored = vi.fn();
    const first = owner.run(
      async (lease) => {
        started.resolve();
        try {
          await lease.native(() => native.promise);
        } finally {
          restored();
        }
      },
      { signal: controller.signal },
    );
    const rejection = expect(first).rejects.toThrow('cancelled');
    await started.promise;
    controller.abort();
    await rejection;
    const next = owner.run(async () => {});
    expect(restored).not.toHaveBeenCalled();
    native.reject(new Error('late native error'));
    await next;
    expect(restored).toHaveBeenCalledOnce();
  });

  it('rejects new native phases after cancellation', async () => {
    vi.useFakeTimers();
    const owner = createOtaOperationOwner();
    const work = deferred<void>();
    const native = vi.fn(async () => {});
    const operation = owner.run(
      async (lease) => {
        await lease.waitFor(work.promise);
        await lease.native(native);
      },
      { timeoutMs: 10 },
    );
    const rejection = expect(operation).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    work.resolve();
    await owner.run(async () => {});
    expect(native).not.toHaveBeenCalled();
  });

  it('quarantines after a failed header restoration', async () => {
    const owner = createOtaOperationOwner();
    await owner.run(async (lease) => {
      lease.quarantine(new Error('restore failed'));
    });
    const callback = vi.fn(async () => {});
    await expect(owner.run(callback)).rejects.toThrow('headers could not be restored');
    expect(callback).not.toHaveBeenCalled();
  });

  it('stops the deadline once reload starts and latches subsequent operations', async () => {
    vi.useFakeTimers();
    const owner = createOtaOperationOwner();
    const nativeReload = deferred<void>();
    const restartStarted = deferred<void>();
    const controller = new AbortController();
    const first = owner.run(
      async (lease) => {
        await lease.reload(() => {
          restartStarted.resolve();
          return nativeReload.promise;
        });
      },
      { timeoutMs: 10, signal: controller.signal },
    );
    await restartStarted.promise;
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    nativeReload.resolve();
    await first;
    await expect(owner.run(async () => {})).rejects.toThrow('restart is already');
  });

  it('releases the terminal latch only after a definite reload rejection', async () => {
    const owner = createOtaOperationOwner();
    await expect(
      owner.run((lease) =>
        lease.reload(async () => {
          throw new Error('reload rejected');
        }),
      ),
    ).rejects.toThrow('reload rejected');
    await expect(owner.run(async () => 'available')).resolves.toBe('available');
  });
});
