import { describe, expect, it, vi } from 'vite-plus/test';
import { buildSchema, execute, parse, subscribe as graphqlSubscribe, validate } from 'graphql';
import { makeServer } from 'graphql-ws';
import { createAsyncIterator } from '../async-iterators';
import { withSubscriptionCleanup } from '../managed-subscription';
import { PubSubChannel } from '../../../../pubsub/channel';

function deferred<Payload>() {
  let resolve!: (payload: Payload) => void;
  const promise = new Promise<Payload>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const unsubscribe = vi.fn();
  let push!: (event: string) => void;
  const source = await createAsyncIterator<string>(async (callback) => {
    push = callback;
    return unsubscribe;
  });
  const ready = deferred<void>();
  const subscribe = withSubscriptionCleanup(async function* (lifetime) {
    const owned = await lifetime.own(Promise.resolve(source));
    ready.resolve();
    for await (const event of owned) yield { audit: event };
  });
  return { source, subscribe, unsubscribe, push, ready };
}

describe('managed subscription lifetime', () => {
  it('preserves authentication errors before opening a source', async () => {
    const subscribe = withSubscriptionCleanup(async function* () {
      yield await Promise.reject(new Error('Not authenticated'));
    });
    await expect(subscribe().next()).rejects.toThrow('Not authenticated');
  });

  it('preserves errors after the initial payload and closes the source', async () => {
    const { source, unsubscribe } = await fixture();
    const subscribe = withSubscriptionCleanup(async function* (lifetime) {
      await lifetime.own(Promise.resolve(source));
      yield 'seed';
      throw new Error('permission lookup failed');
    });
    const iterator = subscribe();
    expect((await iterator.next()).value).toBe('seed');
    await expect(iterator.next()).rejects.toThrow('permission lookup failed');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('cancels an idle read without an event and unsubscribes exactly once', async () => {
    const { subscribe, ready, unsubscribe, push } = await fixture();
    const iterator = subscribe();
    const pending = iterator.next();
    await ready.promise;
    await iterator.return();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    push('late event');
    await iterator.return();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('throw closes the source and wakes pending reads', async () => {
    const { subscribe, ready, unsubscribe } = await fixture();
    const iterator = subscribe();
    const pending = iterator.next();
    await ready.promise;
    await expect(iterator.throw(new Error('cancel'))).rejects.toThrow('cancel');
    expect((await pending).done).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('closes a source whose Redis subscribe finishes after cancellation', async () => {
    const { source, unsubscribe } = await fixture();
    const setup = deferred<typeof source>();
    const started = deferred<void>();
    const subscribe = withSubscriptionCleanup(async function* (lifetime) {
      started.resolve();
      const owned = await lifetime.own(setup.promise);
      for await (const event of owned) yield event;
    });
    const iterator = subscribe();
    const pending = iterator.next();
    await started.promise;
    await iterator.return();
    expect((await pending).done).toBe(true);
    setup.resolve(source);
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
  });

  it('cancels during a seed and discards the late snapshot', async () => {
    const { source, unsubscribe } = await fixture();
    const seed = deferred<string>();
    const started = deferred<void>();
    const subscribe = withSubscriptionCleanup(async function* (lifetime) {
      await lifetime.own(Promise.resolve(source));
      started.resolve();
      yield await seed.promise;
    });
    const iterator = subscribe();
    const pending = iterator.next();
    await started.promise;
    await iterator.return();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect((await pending).done).toBe(true);
    seed.resolve('stale snapshot');
    expect((await iterator.next()).done).toBe(true);
  });

  it('releases an eager subscription if computing the seed fails', async () => {
    const { source, unsubscribe } = await fixture();
    const subscribe = withSubscriptionCleanup(async function* (lifetime) {
      await lifetime.own(Promise.resolve(source));
      yield await Promise.reject(new Error('seed failed'));
    });
    await expect(subscribe().next()).rejects.toThrow('seed failed');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('lets graphql-ws run onDisconnect while the feed is idle', async () => {
    const { subscribe, ready, unsubscribe } = await fixture();
    const disconnected = vi.fn();
    let receive!: (message: string) => Promise<void>;
    const server = makeServer({
      schema: buildSchema('type Query { noop: String } type Subscription { audit: String }'),
      // Use the test runner's GraphQL instance throughout (graphql-ws is external).
      parse,
      validate,
      execute,
      subscribe: graphqlSubscribe,
      roots: { subscription: { audit: subscribe } },
      onDisconnect: disconnected,
    });
    const close = server.opened(
      {
        protocol: 'graphql-transport-ws',
        send: async () => {},
        close: () => {},
        onMessage: (callback) => {
          receive = async (message) => {
            await callback(message);
          };
        },
      },
      {},
    );
    await receive(JSON.stringify({ type: 'connection_init' }));
    const operation = receive(
      JSON.stringify({ id: 'audit', type: 'subscribe', payload: { query: 'subscription { audit }' } }),
    );
    await ready.promise;
    await close(1000, 'test');
    await operation;
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('returns channel counts to baseline over 1000 quiet reconnects', async () => {
    const channel = new PubSubChannel<string>({
      label: 'audit',
      isRedisRequired: () => false,
      logger: { error: vi.fn() },
    });
    const subscribe = withSubscriptionCleanup(async function* (lifetime) {
      const source = await lifetime.own(createAsyncIterator<string>((push) => channel.subscribe('quiet', push)));
      yield 'ready';
      for await (const event of source) yield event;
    });
    for (let cycle = 0; cycle < 1000; cycle++) {
      const iterator = subscribe();
      await iterator.next();
      const pending = iterator.next();
      await iterator.return();
      expect((await pending).done).toBe(true);
    }
    expect(channel.getRuntimeStats()).toEqual({ channels: 0, subscribers: 0 });
  });
});
