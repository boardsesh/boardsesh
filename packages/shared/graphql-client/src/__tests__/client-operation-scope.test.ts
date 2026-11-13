import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client, Sink } from 'graphql-ws';
import { registerClientOperationScope } from '../client-operation-scope';
import { execute } from '../execute';

const operation = { query: 'mutation OriginalIntent { ok }' };
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});
function scripted(rateLimited = false) {
  const subscribe = vi.fn((_payload: unknown, sink: Sink) => {
    queueMicrotask(() => {
      if (rateLimited)
        sink.error([{ message: 'Not executed', extensions: { code: 'RATE_LIMITED', retryAfterSeconds: 1 } }]);
      else {
        sink.next({ data: { ok: true } });
        sink.complete();
      }
    });
    return () => {};
  });
  const client = { subscribe, on: () => () => {}, dispose: () => {}, terminate: () => {}, iterate: vi.fn() };
  return { client: client as unknown as Client, subscribe };
}
function heldSleep() {
  let release = () => {};
  const sleep = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
  return { sleep, release: () => release() };
}

describe('registered operation client scope', () => {
  it('captures once and permits a replacement only within the original intent', async () => {
    const first = scripted(true);
    const replacement = scripted();
    let current = first.client;
    const getter = vi.fn(() => current);
    const guard = vi.fn();
    const scopedGetter = vi.fn(() => current);
    const captured = { getClient: scopedGetter, assertCurrent: guard };
    const capture = vi.fn(() => captured);
    cleanups.push(registerClientOperationScope(getter, capture));
    const pause = heldSleep();
    const result = execute(getter, operation, { sleep: pause.sleep, rateLimitJitterMs: 0 });
    await vi.waitFor(() => expect(pause.sleep).toHaveBeenCalledTimes(1));
    current = replacement.client;
    // Copying the functions also prevents mutation of the returned object from
    // substituting a different guard/getter for this already-started intent.
    captured.getClient = vi.fn(() => {
      throw new Error('must not reread');
    });
    captured.assertCurrent = vi.fn(() => {
      throw new Error('must not reread');
    });
    pause.release();
    await expect(result).resolves.toEqual({ ok: true });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(getter).not.toHaveBeenCalled();
    expect(scopedGetter).toHaveBeenCalledTimes(2);
    expect(replacement.subscribe).toHaveBeenCalledTimes(1);
  });
  it('refuses a changed intent before calling its getter or subscribing again', async () => {
    const first = scripted(true);
    const later = scripted();
    let revision = 0;
    let current = first.client;
    const getter = vi.fn(() => current);
    const scopedGetter = vi.fn(() => current);
    cleanups.push(
      registerClientOperationScope(getter, () => ({
        getClient: scopedGetter,
        assertCurrent() {
          if (revision !== 0) throw new Error('retired intent');
        },
      })),
    );
    const pause = heldSleep();
    const result = execute(getter, operation, { sleep: pause.sleep });
    void result.catch(() => {});
    await vi.waitFor(() => expect(pause.sleep).toHaveBeenCalled());
    revision++;
    current = later.client;
    pause.release();
    await expect(result).rejects.toThrow('retired intent');
    expect(scopedGetter).toHaveBeenCalledTimes(1);
    expect(getter).not.toHaveBeenCalled();
    expect(later.subscribe).not.toHaveBeenCalled();
  });
  it('rechecks after a getter itself changes the view, before subscribe or timeout creation', async () => {
    vi.useFakeTimers();
    const current = scripted();
    let active = true;
    const getter = () => current.client;
    cleanups.push(
      registerClientOperationScope(getter, () => ({
        getClient() {
          active = false;
          return current.client;
        },
        assertCurrent() {
          if (!active) throw new Error('retired intent');
        },
      })),
    );
    await expect(execute(getter, operation)).rejects.toThrow('retired intent');
    expect(current.subscribe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('refuses a result completed immediately before its asynchronous continuation observes a new view', async () => {
    let sink: Sink | undefined;
    let active = true;
    const current = scripted();
    current.client.subscribe = (_payload, observer) => {
      sink = observer;
      return () => {};
    };
    const getter = () => current.client;
    cleanups.push(
      registerClientOperationScope(getter, () => ({
        getClient: getter,
        assertCurrent() {
          if (!active) throw new Error('retired intent');
        },
      })),
    );
    const result = execute(getter, operation);
    sink!.next({ data: { ok: true } });
    sink!.complete();
    active = false;
    await expect(result).rejects.toThrow('retired intent');
  });
  it('registry cleanup and replacement cannot rebind an already-started intent', async () => {
    const first = scripted(true);
    const later = scripted();
    const getter = () => later.client;
    let active = true;
    const capture = vi.fn(() => ({
      getClient: () => first.client,
      assertCurrent() {
        if (!active) throw new Error('retired original');
      },
    }));
    const unregister = registerClientOperationScope(getter, capture);
    cleanups.push(unregister);
    const pause = heldSleep();
    const result = execute(getter, operation, { sleep: pause.sleep });
    void result.catch(() => {});
    await vi.waitFor(() => expect(pause.sleep).toHaveBeenCalled());
    unregister();
    const laterCapture = vi.fn(() => ({ getClient: getter, assertCurrent: () => {} }));
    cleanups.push(registerClientOperationScope(getter, laterCapture));
    active = false;
    pause.release();
    await expect(result).rejects.toThrow('retired original');
    expect(capture).toHaveBeenCalledTimes(1);
    expect(laterCapture).not.toHaveBeenCalled();
    expect(later.subscribe).not.toHaveBeenCalled();
  });
  it('old cleanup cannot remove a newer registration even when its capture function is reused', async () => {
    const current = scripted();
    const getter = vi.fn(() => current.client);
    const capture = vi.fn(() => ({ getClient: () => current.client, assertCurrent: () => {} }));
    const oldCleanup = registerClientOperationScope(getter, capture);
    const currentCleanup = registerClientOperationScope(getter, capture);
    cleanups.push(oldCleanup, currentCleanup);
    oldCleanup();
    await expect(execute(getter, operation)).resolves.toEqual({ ok: true });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(getter).not.toHaveBeenCalled();
    currentCleanup();
    await expect(execute(getter, operation)).resolves.toEqual({ ok: true });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(getter).toHaveBeenCalledTimes(1);
  });
  it('capture failure rejects before a getter, subscription or timer exists', async () => {
    vi.useFakeTimers();
    const getter = vi.fn(() => scripted().client);
    cleanups.push(
      registerClientOperationScope(getter, () => {
        throw new Error('cannot capture');
      }),
    );
    await expect(execute(getter, operation)).rejects.toThrow('cannot capture');
    expect(getter).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('an unregistered ordinary/native getter still follows its replacement after a confirmed rate limit', async () => {
    const first = scripted(true);
    const replacement = scripted();
    let current = first.client;
    const getter = vi.fn(() => current);
    await expect(
      execute(getter, operation, {
        sleep: async () => {
          current = replacement.client;
        },
      }),
    ).resolves.toEqual({ ok: true });
    expect(getter).toHaveBeenCalledTimes(2);
    expect(first.subscribe).toHaveBeenCalledTimes(1);
    expect(replacement.subscribe).toHaveBeenCalledTimes(1);
  });
});
