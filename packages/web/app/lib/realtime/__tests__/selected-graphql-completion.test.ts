import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Client, type Sink, type FormattedExecutionResult } from 'graphql-ws';
import { execute } from '@boardsesh/graphql-client';
import { parse } from 'graphql';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import {
  browserSubscriptionReplayPolicy,
  createBrowserBackendSocketController,
} from '@boardsesh/auth-protocol/browser-backend-socket-controller';

import { OwnedSocket } from '../../../../../shared/auth-protocol/src/__tests__/fixtures/owned-browser-socket';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  OwnedSocket.instances = [];
  vi.useRealTimers();
});
async function fixture() {
  let clock = 0;
  let issuance = 0;
  const owner = {
    userId: 'owned-user-A',
    authSessionId: 'owned-login-A',
    generation: 0,
    cursor: { bindingId: 'a'.repeat(64), version: 1 },
  };
  const session = (selected = owner) => ({
    user: { id: selected.userId },
    authSessionId: selected.authSessionId,
    authGeneration: selected.generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: selected,
  });
  const browser = createBrowserBackendClient({
    ready: () => true,
    fetch: async () =>
      Response.json({ status: 'admitted', token: `bsbd1_OWNED${++issuance}`, usableForMs: 120_000, owner }),
    endpoint: 'https://www.owned.test/api/internal/ws-auth',
    now: () => clock,
    schedule: () => () => {},
  });
  browser.acceptSession(session());
  const original = await browser.acquire(owner);
  const scope = browser.capture(original.token)!;
  let raw!: Client;
  const controller = createBrowserBackendSocketController({
    Socket: OwnedSocket as unknown as typeof WebSocket,
    authority: {
      isCurrent: () => browser.isCurrent(scope),
      assertCurrent: (lease) => browser.assertCurrent(scope, lease),
      acquire: () => browser.acquireScope(scope),
      invalidate: () => browser.invalidate(scope),
    },
    closeEvent: (code, reason, wasClean) => new CloseEvent('close', { code, reason, wasClean }),
    schedule: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    },
    terminate: () => raw.terminate(),
  });
  raw = createClient({
    url: 'wss://api.owned.test/graphql',
    webSocketImpl: controller.Socket,
    connectionParams: async () => ({ authToken: await controller.connectionToken() }),
    retryWait: async () => {},
    retryAttempts: 1,
    lazyCloseTimeout: 3000,
  });
  const subscribe = raw.subscribe.bind(raw);
  const guarded: Client = {
    ...raw,
    subscribe: <Result = Record<string, unknown>, Extensions = unknown>(
      payload: Parameters<Client['subscribe']>[0],
      sink: Sink<FormattedExecutionResult<Result, Extensions>>,
    ) => {
      const { query, operationName, variables, extensions } = payload;
      const bufferedPayload = Object.freeze({ query, operationName, variables, extensions });
      let replay: 'never' | 'subscription' = 'never';
      try {
        replay = browserSubscriptionReplayPolicy(parse(bufferedPayload.query), bufferedPayload.operationName);
      } catch {
        /* Match the hosts: unqualified documents remain single-send. */
      }
      return controller.subscribe((target) => subscribe<Result, Extensions>(bufferedPayload, target), sink, { replay });
    },
  };
  cleanups.push(async () => {
    controller.dispose();
    await raw.dispose();
    browser.dispose();
  });
  const start = async () => {
    const pending = execute<{ private: string }>(guarded, { query: 'mutation Owned { private }' });
    await vi.waitFor(() => expect(OwnedSocket.instances).toHaveLength(1));
    const socket = OwnedSocket.instances[0];
    socket.open();
    await vi.waitFor(() => expect(socket.sent.some((message) => message.type === 'subscribe')).toBe(true));
    const operation = socket.sent.find((message) => message.type === 'subscribe')!;
    return { pending, socket, id: operation.id };
  };
  return {
    browser,
    controller,
    original,
    client: guarded,
    owner,
    scope,
    start,
    advanceTo: (milliseconds: number) => (clock = milliseconds),
    switchAccount: () => browser.acceptSession(session({ ...owner, userId: 'owned-user-B' })),
  };
}

describe('installed graphql-ws buffered completion admission', () => {
  it('resolves a valid next and asynchronous complete for the same original receipt', async () => {
    const current = await fixture();
    const { pending, socket, id } = await current.start();
    socket.receive({ id, type: 'next', payload: { data: { private: 'owned A' } } });
    socket.receive({ id, type: 'complete' });
    expect(await pending).toEqual({ private: 'owned A' });
  });
  it('refuses A next then B before the installed clients asynchronous complete', async () => {
    const current = await fixture();
    const { pending, socket, id } = await current.start();
    socket.receive({ id, type: 'next', payload: { data: { private: 'owned A' } } });
    socket.receive({ id, type: 'complete' });
    current.switchAccount();
    await expect(pending).rejects.toMatchObject({ status: 'superseded' });
  });
  it('refuses expired original data even when a same-owner new lease is admitted', async () => {
    const current = await fixture();
    const { pending, socket, id } = await current.start();
    socket.receive({ id, type: 'next', payload: { data: { private: 'old lease A' } } });
    socket.receive({ id, type: 'complete' });
    current.advanceTo(120_000);
    const refused = expect(pending).rejects.toMatchObject({ status: 'superseded' });
    const renewed = await current.browser.acquireScope(current.scope);
    await refused;
    expect(renewed.token).toBe('bsbd1_OWNED2');
    expect(current.browser.capture(renewed.token)).not.toBeNull();
  });
  it('refuses buffered completion after explicit controller disposal', async () => {
    const current = await fixture();
    const { pending, socket, id } = await current.start();
    socket.receive({ id, type: 'next', payload: { data: { private: 'disposed A' } } });
    socket.receive({ id, type: 'complete' });
    current.controller.dispose();
    await expect(pending).rejects.toMatchObject({ status: 'superseded' });
  });
  it('never replays a lost-result mutation while an actual subscription renews', async () => {
    const current = await fixture();
    const { pending, socket } = await current.start();
    const outcome = pending.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const observer = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };
    const release = current.client.subscribe({ query: 'subscription Feed { private }' }, observer);
    await vi.waitFor(() => expect(socket.sent.filter((message) => message.type === 'subscribe')).toHaveLength(2));
    current.advanceTo(120_000);
    socket.close(4401, 'lease expired after simulated server commit');
    await vi.waitFor(() => expect(OwnedSocket.instances).toHaveLength(2));
    const renewed = OwnedSocket.instances[1];
    renewed.open();
    await vi.waitFor(() => expect(renewed.sent.some((message) => message.type === 'subscribe')).toBe(true));
    const sent = OwnedSocket.instances
      .flatMap((connection) => connection.sent)
      .filter((message) => message.type === 'subscribe');
    expect(sent.filter((message) => (message.payload as { query: string }).query.startsWith('mutation'))).toHaveLength(
      1,
    );
    expect(
      sent.filter((message) => (message.payload as { query: string }).query.startsWith('subscription')),
    ).toHaveLength(2);
    expect(await outcome).toMatchObject({ error: { status: 'unavailable' } });
    const resumed = renewed.sent.find((message) => message.type === 'subscribe')!;
    renewed.receive({ id: resumed.id, type: 'next', payload: { data: { private: 'current lease A' } } });
    expect(observer.next).toHaveBeenCalledExactlyOnceWith({ data: { private: 'current lease A' } });
    expect(observer.error).not.toHaveBeenCalled();
    expect(current.browser.capture('bsbd1_OWNED2')).not.toBeNull();
    release();
  });
  it('disposal before the first send cancels pending work without another account read', async () => {
    const current = await fixture();
    const pending = execute(current.client, { query: 'mutation NeverSent { private }' });
    const refused = expect(pending).rejects.toMatchObject({ status: 'superseded' });
    current.controller.dispose();
    await refused;
    for (const socket of OwnedSocket.instances) socket.open();
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    expect(OwnedSocket.instances.flatMap((socket) => socket.sent)).not.toContainEqual(
      expect.objectContaining({ type: 'subscribe' }),
    );
    expect(current.browser.capture(current.original.token)).not.toBeNull();
  });
  it('caller cleanup before the first send leaves no queued operation to replay', async () => {
    const current = await fixture();
    const observer = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };
    const release = current.client.subscribe({ query: 'mutation Cancelled { private }' }, observer);
    release();
    for (const socket of OwnedSocket.instances) socket.open();
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    expect(OwnedSocket.instances.flatMap((socket) => socket.sent)).not.toContainEqual(
      expect.objectContaining({ type: 'subscribe' }),
    );
    expect(observer.next).not.toHaveBeenCalled();
    expect(observer.error).not.toHaveBeenCalled();
    expect(current.browser.capture(current.original.token)).not.toBeNull();
  });
  it('classification and transmitted bytes use the same captured operation', async () => {
    const current = await fixture();
    const observer = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };
    const payload = {
      query: 'subscription OriginalFeed { private }',
      toJSON: () => ({ query: 'mutation ForgedAtSerialization { private }' }),
    };
    const release = current.client.subscribe(payload, observer);
    payload.query = 'mutation ChangedBeforeSend { private }';
    await vi.waitFor(() => expect(OwnedSocket.instances).toHaveLength(1));
    OwnedSocket.instances[0].open();
    await vi.waitFor(() =>
      expect(OwnedSocket.instances[0].sent.some((message) => message.type === 'subscribe')).toBe(true),
    );
    current.advanceTo(120_000);
    OwnedSocket.instances[0].close(4401, 'renew exact original subscription');
    await vi.waitFor(() => expect(OwnedSocket.instances).toHaveLength(2));
    OwnedSocket.instances[1].open();
    await vi.waitFor(() =>
      expect(OwnedSocket.instances[1].sent.some((message) => message.type === 'subscribe')).toBe(true),
    );
    const sent = OwnedSocket.instances
      .flatMap((socket) => socket.sent)
      .filter((message) => message.type === 'subscribe');
    expect(sent).toHaveLength(2);
    expect(sent.map((message) => (message.payload as { query: string }).query)).toEqual([
      'subscription OriginalFeed { private }',
      'subscription OriginalFeed { private }',
    ]);
    expect(observer.error).not.toHaveBeenCalled();
    release();
  });
  it('drains cancellation through the full lazy-close delay and keeps a fresh operation usable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const current = await fixture();
    const observer = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };
    const release = current.client.subscribe({ query: 'mutation CancelBeforeOpen { private }' }, observer);
    expect(OwnedSocket.instances).toHaveLength(1);
    const cancelled = OwnedSocket.instances[0];
    release();
    cancelled.open();
    for (let turn = 0; turn < 40; turn++) await Promise.resolve();
    expect(cancelled.sent.some((message) => message.type === 'subscribe')).toBe(false);
    await vi.advanceTimersByTimeAsync(2999);
    expect(cancelled.readyState).toBe(OwnedSocket.OPEN);
    await vi.advanceTimersByTimeAsync(1);
    expect(cancelled.readyState).toBe(OwnedSocket.CLOSED);
    expect(vi.getTimerCount()).toBe(0);
    expect(observer.next).not.toHaveBeenCalled();
    expect(observer.error).not.toHaveBeenCalled();
    expect(observer.complete).not.toHaveBeenCalled();
    expect(current.browser.capture(current.original.token)).not.toBeNull();

    const pending = execute(current.client, { query: 'mutation FreshAfterCleanup { private }' });
    expect(OwnedSocket.instances).toHaveLength(2);
    const fresh = OwnedSocket.instances[1];
    fresh.open();
    for (let turn = 0; turn < 40; turn++) await Promise.resolve();
    const sent = fresh.sent.filter((message) => message.type === 'subscribe');
    expect(sent).toHaveLength(1);
    fresh.receive({ id: sent[0].id, type: 'next', payload: { data: { private: 'fresh operation' } } });
    fresh.receive({ id: sent[0].id, type: 'complete' });
    expect(await pending).toEqual({ private: 'fresh operation' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(fresh.readyState).toBe(OwnedSocket.CLOSED);
    expect(vi.getTimerCount()).toBe(0);
    expect(current.browser.capture(current.original.token)).not.toBeNull();
  });
});

describe('host parsed subscription replay policy', () => {
  it.each([
    ['subscription Feed { viewer }', undefined, 'subscription'],
    ['subscription Feed { viewer }', null, 'subscription'],
    ['subscription { viewer }', undefined, 'subscription'],
    ['mutation Change { viewer }', undefined, 'never'],
    ['query Read { viewer }', undefined, 'never'],
    ['{ viewer }', undefined, 'never'],
    ['subscription Feed { viewer } mutation Change { viewer }', 'Feed', 'subscription'],
    ['subscription Feed { viewer } mutation Change { viewer }', 'Change', 'never'],
    ['subscription Feed { viewer } mutation Change { viewer }', undefined, 'never'],
    ['subscription Same { viewer } mutation Same { viewer }', 'Same', 'never'],
    ['subscription Feed { viewer }', 'Missing', 'never'],
    ['{ viewer } subscription Feed { viewer }', 'Feed', 'never'],
    ['# subscription Fake\nmutation Change { viewer }', undefined, 'never'],
  ] as const)('classifies the selected actual operation in %s', (query, operationName, expected) => {
    expect(browserSubscriptionReplayPolicy(parse(query), operationName)).toBe(expected);
  });
});
