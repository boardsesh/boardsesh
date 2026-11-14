import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserCoordinatorRunner,
  type BrowserCoordinatorTransport,
  type CoordinatorTimer,
  type CoordinatorRequestContext,
} from '../browser-coordinator-runner';
import type { BrowserCoordinatorCommand } from '../browser-coordinator-v1';
const cursor = { bindingId: 'a'.repeat(64), version: 2 };
const ready = { status: 'ready', cursor } as const;
function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let count = 0; count < 8; count++) await Promise.resolve();
};
function fixture(transport: BrowserCoordinatorTransport) {
  const timers = new Set<() => void>();
  const schedule: CoordinatorTimer = (callback) => {
    timers.add(callback);
    return () => {
      timers.delete(callback);
    };
  };
  let tail: Promise<unknown> = Promise.resolve();
  const withExclusiveLock = <Result>(operation: () => Promise<Result>) => {
    const completion = tail.then(operation, operation);
    tail = completion.catch(() => {});
    return completion;
  };
  return { run: createBrowserCoordinatorRunner({ transport, schedule, withExclusiveLock, timeoutMs: 15_000 }), timers };
}
describe('canonical lock and network settlement', () => {
  it('coalesces cold callers, confirms installation, then reuses the cookie', async () => {
    let installed = false;
    const observe = vi.fn(async () => (installed ? ready : { status: 'missing-binding' }));
    const initialize = vi.fn(async (context: CoordinatorRequestContext) => {
      expect(context).toMatchObject({ credentials: 'include', keepalive: false, cache: 'no-store' });
      installed = true;
    });
    const { run, timers } = fixture({ observe, initialize });
    await expect(Promise.all([run({ operation: 'read' }), run({ operation: 'read' })])).resolves.toEqual([
      ready,
      ready,
    ]);
    expect(initialize).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(3);
    expect(timers.size).toBe(0);
  });
  it('keeps initialization unmounted by default', async () => {
    const observe = vi.fn(async () => ({ status: 'missing-binding' }));
    await expect(fixture({ observe }).run({ operation: 'read' })).resolves.toEqual({ status: 'unavailable' });
    expect(observe).toHaveBeenCalledOnce();
  });
  it('retries lost preheader work without a permanent pending marker', async () => {
    let installed = false;
    const initialize = vi
      .fn()
      .mockRejectedValueOnce(new Error('request lost'))
      .mockImplementationOnce(async () => {
        installed = true;
      });
    const { run } = fixture({ observe: async () => (installed ? ready : { status: 'missing-binding' }), initialize });
    await expect(run({ operation: 'read' })).resolves.toEqual({ status: 'unavailable' });
    await expect(run({ operation: 'read' })).resolves.toEqual(ready);
    expect(initialize).toHaveBeenCalledTimes(2);
  });
  it('reuses installed headers after body failure', async () => {
    let installed = false;
    const initialize = vi.fn(async () => {
      installed = true;
      throw new Error('truncated body');
    });
    const { run } = fixture({ observe: async () => (installed ? ready : { status: 'missing-binding' }), initialize });
    await expect(run({ operation: 'read' })).resolves.toEqual({ status: 'unavailable' });
    await expect(run({ operation: 'read' })).resolves.toEqual(ready);
    expect(initialize).toHaveBeenCalledOnce();
  });
  it.each(['abort', 'timeout'] as const)('holds the lock after %s until old work settles', async (reason) => {
    const first = deferred<unknown>();
    const observe = vi
      .fn<(context: CoordinatorRequestContext) => Promise<unknown>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(ready);
    const { run, timers } = fixture({ observe });
    const controller = new AbortController();
    const old = run({ operation: 'read' }, controller.signal);
    await flush();
    if (reason === 'abort') controller.abort();
    else [...timers][0]();
    expect(observe.mock.calls[0][0].signal.aborted).toBe(true);
    const newer = run({ operation: 'read' });
    await flush();
    expect(observe).toHaveBeenCalledOnce();
    first.resolve(ready);
    await expect(old).resolves.toEqual({ status: 'unavailable' });
    await expect(newer).resolves.toEqual(ready);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(timers.size).toBe(0);
  });
  it('never initializes/falls through after proof-required', async () => {
    const initialize = vi.fn();
    await expect(
      fixture({ observe: async () => ({ status: 'proof-required' }), initialize }).run({ operation: 'read' }),
    ).resolves.toEqual({ status: 'proof-required' });
    expect(initialize).not.toHaveBeenCalled();
  });
  it('returns unavailable for blocked cookies without an initialization loop', async () => {
    const initialize = vi.fn(async () => {});
    const observe = vi.fn(async () => ({ status: 'missing-binding' }));
    await expect(fixture({ observe, initialize }).run({ operation: 'read' })).resolves.toEqual({
      status: 'unavailable',
    });
    expect(initialize).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(2);
  });
  it('rejects identity/credential-bearing transport replies', async () => {
    await expect(
      fixture({ observe: async () => ({ ...ready, token: 'must-not-cross', userId: 'must-not-cross' }) }).run({
        operation: 'read',
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });
  it.each(['prepare', 'renew'] as const)('requires the exact expected cursor for %s', async (operation) => {
    const transport = {
      observe: async () => ready,
      prepare: async () => ({ ...ready, cursor: { ...cursor, version: 3 } }),
      renew: async () => ({ ...ready, renewal: 'renewed', cursor: { ...cursor, bindingId: 'b'.repeat(64) } }),
    };
    const command: BrowserCoordinatorCommand =
      operation === 'prepare'
        ? { operation, transition: 'logout', expectedCursor: cursor }
        : { operation, expectedCursor: cursor };
    await expect(fixture(transport).run(command)).resolves.toEqual({ status: 'conflict' });
  });
  it.each(['unchanged', 'renewed'] as const)('projects only an exact typed %s renewal', async (renewal) => {
    const future = { ...cursor, version: cursor.version + (renewal === 'renewed' ? 1 : 0) };
    const { run } = fixture({
      observe: async () => ready,
      renew: async () => ({ status: 'ready', cursor: future, renewal }),
    });
    await expect(run({ operation: 'renew', expectedCursor: cursor })).resolves.toEqual({
      status: 'ready',
      cursor: future,
    });
  });
  it.each([
    ['unchanged', 3],
    ['renewed', 2],
    ['renewed', 4],
  ] as const)('refuses %s renewal at invalid version%s', async (renewal, version) => {
    const { run } = fixture({
      observe: async () => ready,
      renew: async () => ({ status: 'ready', cursor: { ...cursor, version }, renewal }),
    });
    await expect(run({ operation: 'renew', expectedCursor: cursor })).resolves.toEqual({ status: 'conflict' });
  });
  it('requires typed renewal evidence before projecting a same-version success', async () => {
    const { run } = fixture({ observe: async () => ready, renew: async () => ready });
    await expect(run({ operation: 'renew', expectedCursor: cursor })).resolves.toEqual({ status: 'unavailable' });
  });
  it('captures command and transport primitives before lock waits', async () => {
    const prepare = vi.fn(async (_command: BrowserCoordinatorCommand) => ready);
    const transport = { observe: async () => ready, prepare };
    const { run } = fixture(transport);
    const command = { operation: 'prepare', transition: 'replacement', expectedCursor: { ...cursor } } as const;
    const completion = run(command);
    Object.assign(command.expectedCursor, { version: 999 });
    Object.assign(transport, { prepare: vi.fn(async () => ({ status: 'unavailable' })) });
    await expect(completion).resolves.toEqual(ready);
    expect(prepare.mock.calls[0][0]).toMatchObject({ expectedCursor: cursor });
  });
  it('does no network work for an already cancelled caller', async () => {
    const controller = new AbortController();
    controller.abort();
    const observe = vi.fn();
    await expect(fixture({ observe }).run({ operation: 'read' }, controller.signal)).resolves.toEqual({
      status: 'unavailable',
    });
    expect(observe).not.toHaveBeenCalled();
  });
});
