import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectBrowserCoordinatorClient,
  createBrowserCoordinatorEndpoint,
  type CoordinatorPort,
  type CoordinatorClientPlatform,
  type CoordinatorConnectEvent,
} from '../browser-coordinator-channel';
import type { BrowserCoordinatorResult } from '../browser-coordinator-v1';
const cursor = { bindingId: 'a'.repeat(64), version: 2 };
const ready = { status: 'ready', cursor } as const;
const www = 'https://www.boardsesh.test';
const app = 'https://app.boardsesh.test';
const cleanups: (() => void)[] = [];
const flush = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};
function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function wrap(port: MessagePort, posted: unknown[]): CoordinatorPort {
  cleanups.push(() => port.close());
  return {
    post(message) {
      posted.push(message);
      port.postMessage(message);
    },
    listen(message, disconnected) {
      const handler = (event: MessageEvent<unknown>) => message(event.data);
      port.addEventListener('message', handler);
      port.addEventListener('close', disconnected);
      port.start();
      return () => {
        port.removeEventListener('message', handler);
        port.removeEventListener('close', disconnected);
      };
    },
    close: () => port.close(),
  };
}
function fixture(
  run: (command: unknown, signal: AbortSignal) => Promise<BrowserCoordinatorResult> = async () => ready,
  origin = app,
) {
  const source = {};
  const target = {};
  const posted: unknown[] = [];
  const endpoint = createBrowserCoordinatorEndpoint({ peers: [{ origin, source }], run });
  cleanups.push(() => endpoint.close());
  const timers = new Set<() => void>();
  let remote!: MessagePort;
  let connectMessage: unknown;
  const postConnect = vi.fn((_target: object, exactOrigin: string, message: unknown, transferred: unknown) => {
    expect(_target).toBe(target);
    expect(exactOrigin).toBe(www);
    connectMessage = message;
    endpoint.receive({ origin, source, message, ports: [wrap(transferred as MessagePort, posted)] });
  });
  const platform: CoordinatorClientPlatform = {
    newId: () => crypto.randomUUID(),
    schedule(callback) {
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
    createChannel() {
      const pair = new MessageChannel();
      remote = pair.port2;
      return { local: wrap(pair.port1, posted), remote };
    },
    postConnect,
  };
  const connect = () => connectBrowserCoordinatorClient({ canonicalOrigin: www, target, platform, timeoutMs: 15_000 });
  return {
    connect,
    platform,
    timers,
    endpoint,
    source,
    posted,
    postConnect,
    remote: () => remote,
    message: () => connectMessage,
  };
}

describe('shared www/app coordinator MessageChannel transport', () => {
  it.each([www, app])('uses an isolated transferred channel for %s and returns metadata only', async (origin) => {
    const current = fixture(undefined, origin);
    const client = await current.connect();
    await expect(client.request({ operation: 'read' })).resolves.toEqual(ready);
    expect(client.cursor()).toEqual(cursor);
    expect(current.postConnect).toHaveBeenCalledOnce();
    expect(current.timers.size).toBe(0);
    client.close();
  });

  it.each(['origin', 'source', 'extra-port', 'credential-field'] as const)(
    'rejects an untrusted %s handshake',
    async (kind) => {
      const current = fixture();
      const ports = [{ post: vi.fn(), listen: vi.fn(), close: vi.fn() }];
      if (kind === 'extra-port') ports.push({ post: vi.fn(), listen: vi.fn(), close: vi.fn() });
      const event: CoordinatorConnectEvent = {
        origin: kind === 'origin' ? 'https://app.boardsesh.test.attacker.test' : app,
        source: kind === 'source' ? {} : current.source,
        message: {
          protocolVersion: 1,
          type: 'connect',
          connectionId: crypto.randomUUID(),
          ...(kind === 'credential-field' ? { token: 'must-not-cross' } : {}),
        },
        ports,
      };
      current.endpoint.receive(event);
      for (const port of ports) {
        expect(port.close).toHaveBeenCalledOnce();
        expect(port.post).not.toHaveBeenCalled();
      }
    },
  );

  it('refuses a slow older cursor after a newer response has completed', async () => {
    const earlier = deferred<BrowserCoordinatorResult>();
    let calls = 0;
    const current = fixture(async () =>
      ++calls === 1 ? earlier.promise : { status: 'ready', cursor: { ...cursor, version: 3 } },
    );
    const client = await current.connect();
    const old = client.request({ operation: 'read' });
    const newer = client.request({ operation: 'read' });
    await expect(newer).resolves.toMatchObject({ cursor: { version: 3 } });
    earlier.resolve(ready);
    await expect(old).resolves.toEqual({ status: 'conflict' });
    expect(client.cursor()?.version).toBe(3);
    client.close();
  });

  it('does not replace the binding cursor from an unrelated response', async () => {
    let calls = 0;
    const current = fixture(async () =>
      ++calls === 1 ? ready : { status: 'ready', cursor: { bindingId: 'b'.repeat(64), version: 999 } },
    );
    const client = await current.connect();
    await client.request({ operation: 'read' });
    await expect(client.request({ operation: 'read' })).resolves.toEqual({ status: 'conflict' });
    expect(client.cursor()).toEqual(cursor);
    client.close();
  });

  it('aborts pending server work and ignores its late result after caller cancellation', async () => {
    const completion = deferred<BrowserCoordinatorResult>();
    let signal: AbortSignal | undefined;
    const current = fixture(async (_command, captured) => {
      signal = captured;
      return completion.promise;
    });
    const client = await current.connect();
    const controller = new AbortController();
    const result = client.request({ operation: 'read' }, controller.signal);
    await flush();
    controller.abort();
    await expect(result).resolves.toEqual({ status: 'unavailable' });
    await flush();
    expect(signal?.aborted).toBe(true);
    completion.resolve(ready);
    await flush();
    expect(client.cursor()).toBeNull();
    client.close();
  });

  it('settles connection failure within its injected deadline', async () => {
    const current = fixture();
    Object.assign(current.platform, { postConnect: () => {} });
    const connecting = current.connect();
    for (const expire of current.timers) expire();
    await expect(connecting).rejects.toThrow('COORDINATOR_UNAVAILABLE');
  });

  it('times out requests, cancels server work and lets a later request proceed', async () => {
    const completion = deferred<BrowserCoordinatorResult>();
    let calls = 0;
    let signal: AbortSignal | undefined;
    const current = fixture(async (_command, captured) => {
      signal = captured;
      return ++calls === 1 ? completion.promise : ready;
    });
    const client = await current.connect();
    const old = client.request({ operation: 'read' });
    await flush();
    for (const expire of current.timers) expire();
    await expect(old).resolves.toEqual({ status: 'unavailable' });
    await flush();
    expect(signal?.aborted).toBe(true);
    await expect(client.request({ operation: 'read' })).resolves.toEqual(ready);
    completion.resolve({ status: 'ready', cursor: { ...cursor, version: 1 } });
    await flush();
    expect(client.cursor()).toEqual(cursor);
    client.close();
  });

  it('never forwards a secret-bearing injected result', async () => {
    const current = fixture(async () => ({ ...ready, password: 'must-not-cross' }));
    const client = await current.connect();
    await expect(client.request({ operation: 'read' })).resolves.toEqual({ status: 'unavailable' });
    expect(JSON.stringify(current.posted)).not.toContain('must-not-cross');
    client.close();
  });

  it.each(['connectionId', 'requestId', 'operation'] as const)(
    'does not accept a mismatched reply %s',
    async (field) => {
      const pending = deferred<BrowserCoordinatorResult>();
      const current = fixture(async () => pending.promise);
      const client = await current.connect();
      const result = client.request({ operation: 'read' });
      await flush();
      const sent = current.posted.find(
        (message) => typeof message === 'object' && message !== null && 'type' in message && message.type === 'request',
      ) as Record<string, unknown>;
      current.remote().postMessage({
        ...sent,
        type: 'result',
        operation: 'read',
        result: ready,
        [field]: field === 'operation' ? 'renew' : crypto.randomUUID(),
      });
      await flush();
      if (field === 'requestId') {
        expect(client.cursor()).toBeNull();
        client.close();
      }
      await expect(result).resolves.toEqual({ status: 'unavailable' });
      pending.resolve(ready);
    },
  );

  it('aborts all work on endpoint teardown without accepting later requests', async () => {
    const pending = deferred<BrowserCoordinatorResult>();
    let signal: AbortSignal | undefined;
    const current = fixture(async (_command, captured) => {
      signal = captured;
      return pending.promise;
    });
    const client = await current.connect();
    const result = client.request({ operation: 'read' });
    await flush();
    current.endpoint.close();
    await expect(result).resolves.toEqual({ status: 'unavailable' });
    expect(signal?.aborted).toBe(true);
    await expect(client.request({ operation: 'read' })).resolves.toEqual({ status: 'unavailable' });
    pending.resolve(ready);
  });
  it.each([
    ['prepare', 'version'],
    ['prepare', 'binding'],
    ['renew', 'version'],
    ['renew', 'binding'],
  ] as const)(
    'refuses a %s completion with mismatched expected %s before cursor publication',
    async (operation, mismatch) => {
      let calls = 0;
      const current = fixture(async () =>
        ++calls === 1
          ? ready
          : {
              status: 'ready',
              cursor:
                mismatch === 'version'
                  ? { ...cursor, version: operation === 'renew' ? 4 : 3 }
                  : { bindingId: 'b'.repeat(64), version: cursor.version },
            },
      );
      const client = await current.connect();
      await client.request({ operation: 'read' });
      const command =
        operation === 'prepare'
          ? { operation, transition: 'logout' as const, expectedCursor: cursor }
          : { operation, expectedCursor: cursor };
      await expect(client.request(command)).resolves.toEqual({ status: 'conflict' });
      expect(client.cursor()).toEqual(cursor);
      client.close();
    },
  );
  it.each([0, 1])('accepts only same-binding renewal delta%s from the canonical runner', async (delta) => {
    let calls = 0;
    const next = { ...cursor, version: cursor.version + delta };
    const current = fixture(async () => (++calls === 1 ? ready : { status: 'ready', cursor: next }));
    const client = await current.connect();
    await client.request({ operation: 'read' });
    await expect(client.request({ operation: 'renew', expectedCursor: cursor })).resolves.toEqual({
      status: 'ready',
      cursor: next,
    });
    expect(client.cursor()).toEqual(next);
    client.close();
  });

  it('closes at the bounded request lifetime and recovers through a fresh connection/read', async () => {
    const current = fixture();
    const client = await current.connect();
    for (let request = 0; request < 256; request++) {
      await expect(client.request({ operation: 'read' })).resolves.toEqual(ready);
    }
    expect(client.isClosed()).toBe(false);
    await expect(client.request({ operation: 'read' })).resolves.toEqual({ status: 'unavailable' });
    expect(client.isClosed()).toBe(true);
    const reconnected = await current.connect();
    expect(reconnected.cursor()).toBeNull();
    await expect(reconnected.request({ operation: 'read' })).resolves.toEqual(ready);
    expect(reconnected.isClosed()).toBe(false);
    reconnected.close();
  });
});
