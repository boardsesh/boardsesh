import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('browser auth cookie lock', () => {
  it('serializes cookie operations in one realm when Web Locks are unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const { withAuthCookieLock } = await import('../auth-cookie-lock.web');
    const executionOrder: string[] = [];
    let releaseFirstOperation!: () => void;

    const firstOperation = withAuthCookieLock(async () => {
      executionOrder.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirstOperation = resolve;
      });
      executionOrder.push('first:end');
    });
    const secondOperation = withAuthCookieLock(async () => {
      executionOrder.push('second');
    });

    await vi.waitFor(() => expect(executionOrder).toEqual(['first:start']));
    releaseFirstOperation();
    await Promise.all([firstOperation, secondOperation]);

    expect(executionOrder).toEqual(['first:start', 'first:end', 'second']);
  });

  it('uses the origin-scoped Web Lock when the browser provides it', async () => {
    const request = vi.fn(async (_name: string, _options: LockOptions, operation: () => Promise<string>) =>
      operation(),
    );
    vi.stubGlobal('navigator', { locks: { request } });
    const { withAuthCookieLock } = await import('../auth-cookie-lock.web');

    await expect(withAuthCookieLock(async () => 'complete')).resolves.toBe('complete');
    expect(request).toHaveBeenCalledWith('boardsesh-nextauth-cookie-v1', { mode: 'exclusive' }, expect.any(Function));
  });

  it('releases the fallback queue after a rejected operation', async () => {
    vi.stubGlobal('navigator', {});
    const { withAuthCookieLock } = await import('../auth-cookie-lock.web');

    await expect(
      withAuthCookieLock(async () => {
        throw new Error('failed mutation');
      }),
    ).rejects.toThrow('failed mutation');
    await expect(withAuthCookieLock(async () => 'next mutation')).resolves.toBe('next mutation');
  });

  it('aborts a queued fallback operation without running it later', async () => {
    vi.stubGlobal('navigator', {});
    const { withAuthCookieLock } = await import('../auth-cookie-lock.web');
    let releaseFirstOperation!: () => void;
    const firstOperation = withAuthCookieLock(
      () =>
        new Promise<void>((resolve) => {
          releaseFirstOperation = resolve;
        }),
    );
    const queuedOperation = vi.fn(async () => 'must-not-run');
    const followingOperation = vi.fn(async () => 'next-operation');
    const abortController = new AbortController();
    const queuedResult = withAuthCookieLock(queuedOperation, abortController.signal);
    abortController.abort(new Error('superseded lock wait'));
    const followingResult = withAuthCookieLock(followingOperation);

    await expect(queuedResult).rejects.toThrow('superseded lock wait');
    expect(followingOperation).not.toHaveBeenCalled();
    releaseFirstOperation();
    await firstOperation;
    await expect(followingResult).resolves.toBe('next-operation');
    expect(queuedOperation).not.toHaveBeenCalled();
  });

  it('does not abort a fallback operation after it acquires the queue', async () => {
    vi.stubGlobal('navigator', {});
    const { withAuthCookieLock } = await import('../auth-cookie-lock.web');
    const abortController = new AbortController();
    let releaseOperation!: () => void;
    const runningOperation = withAuthCookieLock(
      () =>
        new Promise<string>((resolve) => {
          releaseOperation = () => resolve('completed');
        }),
      abortController.signal,
    );

    await vi.waitFor(() => expect(releaseOperation).toBeTypeOf('function'));
    abortController.abort(new Error('lock wait expired'));
    releaseOperation();

    await expect(runningOperation).resolves.toBe('completed');
  });
});
