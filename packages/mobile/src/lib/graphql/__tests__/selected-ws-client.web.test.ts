// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execute } from '@boardsesh/graphql-client';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { createSelectedBrowserWsClient } from '../selected-ws-client.web';
import { OwnedSocket } from '../../../../../shared/auth-protocol/src/__tests__/fixtures/owned-browser-socket';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  OwnedSocket.instances = [];
  vi.useRealTimers();
});
function fixture() {
  let clock = 0;
  let generation = 0;
  let issuance = 0;
  let owner = {
    userId: 'owned-A',
    authSessionId: 'owned-login-A',
    generation: 0,
    cursor: { bindingId: 'a'.repeat(64), version: 1 },
  };
  const session = () => ({
    user: { id: owner.userId },
    authSessionId: owner.authSessionId,
    authGeneration: owner.generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: owner,
  });
  const fetch = vi.fn<(...parameters: unknown[]) => Promise<Response>>(async () =>
    Response.json({ status: 'admitted', token: `bsbd1_OWNED${++issuance}`, usableForMs: 120_000, owner }),
  );
  const browser = createBrowserBackendClient({
    ready: () => true,
    fetch,
    endpoint: 'https://www.owned.test/api/internal/ws-auth',
    now: () => clock,
    schedule(callback, milliseconds) {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    },
  });
  const ownerListeners = new Set<() => void>();
  const generationListeners = new Set<() => void>();
  const backendClient = {
    ...browser,
    subscribe(listener: () => void) {
      ownerListeners.add(listener);
      const unsubscribe = browser.subscribe(listener);
      return () => {
        ownerListeners.delete(listener);
        unsubscribe();
      };
    },
  };
  browser.acceptSession(session());
  const onRetiring = vi.fn();
  const onConnectionEnded = vi.fn();
  const onDisposed = vi.fn();
  const create = () => {
    const entry = createSelectedBrowserWsClient({
      backendClient,
      url: 'wss://api.owned.test/graphql',
      Socket: OwnedSocket as unknown as typeof WebSocket,
      clientIdentity: () => 'boardsesh-mobile-web/owned (web)',
      captureGeneration: () => generation,
      isGenerationCurrent: (expected) => expected === generation,
      subscribeGeneration(listener) {
        generationListeners.add(listener);
        return () => generationListeners.delete(listener);
      },
      closeEvent: (code, reason, wasClean) => new CloseEvent('close', { code, reason, wasClean }),
      schedule(callback, milliseconds) {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      },
      onRetiring,
      onConnectionEnded,
      onDisposed,
    });
    cleanups.push(() => entry.client.dispose());
    return entry;
  };
  cleanups.push(() => browser.dispose());
  const open = async (index: number) => {
    await vi.waitFor(() => expect(OwnedSocket.instances.length).toBeGreaterThan(index));
    const socket = OwnedSocket.instances[index];
    socket.open();
    await vi.waitFor(() => expect(socket.sent.some((message) => message.type === 'subscribe')).toBe(true));
    return socket;
  };
  return {
    create,
    browser,
    fetch,
    open,
    ownerListeners,
    generationListeners,
    onRetiring,
    onConnectionEnded,
    onDisposed,
    advanceTo: (milliseconds: number) => (clock = milliseconds),
    retireGeneration() {
      generation++;
      const currentListeners = Array.from(generationListeners);
      for (const listener of currentListeners) listener();
    },
    switchAccount() {
      owner = { ...owner, userId: 'owned-B', cursor: { ...owner.cursor, version: 2 } };
      browser.acceptSession(session());
    },
    restoreAccount() {
      owner = { ...owner, userId: 'owned-A', cursor: { ...owner.cursor, version: 1 } };
      browser.acceptSession(session());
    },
  };
}
const observer = () => ({ next: vi.fn(), error: vi.fn(), complete: vi.fn() });

describe('unmounted selected Expo browser WebSocket client', () => {
  it('uses actual source admission before a fixed-owner handshake and actual result', async () => {
    const current = fixture();
    const entry = current.create();
    expect(current.fetch).not.toHaveBeenCalled();
    const pending = execute(entry.client, { query: 'mutation Owned { private }' });
    const socket = await current.open(0);
    expect(current.fetch).toHaveBeenCalledTimes(1);
    expect(socket.sent.find((message) => message.type === 'connection_init')?.payload).toMatchObject({
      authToken: 'bsbd1_OWNED1',
      clientPlatform: 'web',
      clientIdentity: 'boardsesh-mobile-web/owned (web)',
    });
    const sent = socket.sent.find((message) => message.type === 'subscribe')!;
    socket.receive({ id: sent.id, type: 'next', payload: { data: { private: 'owned A' } } });
    socket.receive({ id: sent.id, type: 'complete' });
    expect(await pending).toEqual({ private: 'owned A' });
  });
  it('unused pull iteration refuses before any source call, socket or send and disposes cleanly', async () => {
    const current = fixture();
    const entry = current.create();
    const iterator = entry.client.iterate({ query: 'mutation MustNotEscape { private }' });
    await expect(iterator.next()).rejects.toMatchObject({ status: 'unavailable' });
    expect(await iterator.return!()).toEqual({ done: true, value: undefined });
    expect(current.fetch).not.toHaveBeenCalled();
    expect(OwnedSocket.instances).toHaveLength(0);
    await entry.client.dispose();
    expect(current.ownerListeners.size).toBe(0);
    expect(current.generationListeners.size).toBe(0);
    expect(current.onRetiring).toHaveBeenCalledExactlyOnceWith(entry.client);
    expect(current.onDisposed).toHaveBeenCalledExactlyOnceWith(entry.client);
    expect(current.browser.getSnapshot().owner?.userId).toBe('owned-A');
  });
  it('a construction-time A client cannot acquire B or a later A on its first subscription', async () => {
    const current = fixture();
    const entry = current.create();
    current.switchAccount();
    current.restoreAccount();
    const sink = observer();
    entry.client.subscribe({ query: 'subscription Feed { private }' }, sink);
    expect(sink.error).toHaveBeenCalledWith(expect.objectContaining({ status: 'superseded' }));
    expect(current.fetch).not.toHaveBeenCalled();
    expect(OwnedSocket.instances).toHaveLength(0);
  });
  it('the platform generation retires a pending client before any transport starts', async () => {
    const current = fixture();
    const entry = current.create();
    current.retireGeneration();
    const sink = observer();
    entry.client.subscribe({ query: 'mutation OldIntent { private }' }, sink);
    expect(entry.isCurrent()).toBe(false);
    expect(sink.error).toHaveBeenCalledWith(expect.objectContaining({ status: 'superseded' }));
    expect(OwnedSocket.instances).toHaveLength(0);
    expect(current.browser.getSnapshot().owner?.userId).toBe('owned-A');
  });
  it('late A frames and disposal cannot affect a newly admitted B client', async () => {
    const current = fixture();
    const old = current.create();
    const oldSink = observer();
    old.client.subscribe({ query: 'subscription Feed { private }' }, oldSink);
    const oldSocket = await current.open(0);
    const oldSent = oldSocket.sent.find((message) => message.type === 'subscribe')!;
    current.switchAccount();
    const next = current.create();
    const nextSink = observer();
    next.client.subscribe({ query: 'subscription Feed { private }' }, nextSink);
    const nextSocket = await current.open(1);
    const nextSent = nextSocket.sent.find((message) => message.type === 'subscribe')!;
    oldSocket.receive({ id: oldSent.id, type: 'next', payload: { data: { private: 'old A' } } });
    old.dispose();
    nextSocket.receive({ id: nextSent.id, type: 'next', payload: { data: { private: 'current B' } } });
    expect(oldSink.next).not.toHaveBeenCalled();
    expect(nextSink.next).toHaveBeenCalledExactlyOnceWith({ data: { private: 'current B' } });
    expect(next.isCurrent()).toBe(true);
    expect(current.onRetiring).toHaveBeenCalledTimes(1);
  });
  it('repeated disposal removes listeners once and preserves source admission', async () => {
    const current = fixture();
    const entry = current.create();
    expect(current.ownerListeners.size).toBe(1);
    expect(current.generationListeners.size).toBe(1);
    await entry.client.dispose();
    entry.dispose();
    await entry.client.dispose();
    expect(current.ownerListeners.size).toBe(0);
    expect(current.generationListeners.size).toBe(0);
    expect(current.onRetiring).toHaveBeenCalledTimes(1);
    expect(current.onDisposed).toHaveBeenCalledTimes(1);
    expect(current.browser.isAnonymous()).toBe(false);
    expect(current.browser.getSnapshot().owner?.userId).toBe('owned-A');
  });
});
