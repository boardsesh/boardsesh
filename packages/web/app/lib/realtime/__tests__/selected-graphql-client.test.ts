import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateGraphQLClientOptions, ExtendedClient } from '@boardsesh/graphql-client';
import type { Sink, FormattedExecutionResult } from 'graphql-ws';
import { createBrowserBackendClient } from '@/app/lib/auth/browser-backend-client';

const fixture = vi.hoisted(() => {
  class OwnedSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly sent: unknown[] = [];
    readonly closes: number[] = [];
    readyState = 1;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    closeListener: ((event: Event) => void) | undefined;
    set onclose(listener: ((event: CloseEvent) => void) | null) {
      if (this.closeListener) this.removeEventListener('close', this.closeListener);
      this.closeListener = listener ? (event) => listener(event as CloseEvent) : undefined;
      if (this.closeListener) this.addEventListener('close', this.closeListener);
    }
    send(contents: unknown) {
      this.sent.push(contents);
    }
    close(code = 1000) {
      this.closes.push(code);
      this.readyState = 3;
    }
  }
  vi.stubGlobal('WebSocket', OwnedSocket);
  return {
    OwnedSocket,
    browser: null as ReturnType<typeof createBrowserBackendClient> | null,
    created: [] as {
      options: CreateGraphQLClientOptions;
      client: ExtendedClient;
      sinks: Sink<FormattedExecutionResult>[];
      releases: ReturnType<typeof vi.fn>[];
      terminate: ReturnType<typeof vi.fn>;
    }[],
  };
});
vi.mock('@/app/lib/auth/browser-backend-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/auth/browser-backend-client')>();
  return {
    ...actual,
    browserBackendClient: new Proxy(actual.browserBackendClient, {
      get(_target, property) {
        return Reflect.get(fixture.browser ?? actual.browserBackendClient, property);
      },
    }),
  };
});
vi.mock('../websocket-connection-manager', () => ({ connectionManager: { registerClient: () => () => {} } }));
vi.mock('@boardsesh/graphql-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/graphql-client')>();
  return {
    ...actual,
    createGraphQLClient(options: CreateGraphQLClientOptions) {
      const sinks: Sink<FormattedExecutionResult>[] = [];
      const releases: ReturnType<typeof vi.fn>[] = [];
      const terminate = vi.fn();
      const client = {
        subscribe: vi.fn((_payload, sink: Sink<FormattedExecutionResult>) => {
          sinks.push(sink);
          const release = vi.fn();
          releases.push(release);
          return release;
        }),
        terminate,
        dispose: vi.fn(),
      } as unknown as ExtendedClient;
      const cleanup = options.onClientCreated?.(client);
      vi.mocked(client.dispose).mockImplementation(async () => {
        cleanup?.();
      });
      fixture.created.push({ options, client, sinks, releases, terminate });
      return client;
    },
  };
});
import { createGraphQLClient } from '../graphql-client';

function owner() {
  return {
    userId: 'owned-user-A',
    authSessionId: 'owned-login-A',
    generation: 0,
    cursor: { bindingId: 'a'.repeat(64), version: 1 },
  };
}
function session(scope = owner()) {
  return {
    user: { id: scope.userId },
    authSessionId: scope.authSessionId,
    authGeneration: scope.generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: scope,
  };
}
let currentOwner: ReturnType<typeof owner>;
let clock: number;
let leaseFetch: ReturnType<typeof vi.fn<typeof fetch>>;
async function createSelectedClient() {
  const lease = await fixture.browser!.acquire(currentOwner);
  const client = createGraphQLClient({ url: 'wss://api.owned.test/graphql', authToken: lease.token });
  const entry = fixture.created.at(-1)!;
  const connection = await connect(entry);
  return { client, entry, reconnect: () => connect(entry), ...connection, lease };
}
async function connect(entry: (typeof fixture.created)[number]) {
  if (!entry.options.connectionParams) throw new Error('Missing selected connection provider');
  const Socket = entry.options.webSocketImpl!;
  const socket = new Socket('wss://api.owned.test/graphql') as unknown as InstanceType<typeof fixture.OwnedSocket>;
  const closed = vi.fn();
  socket.onclose = closed;
  let handshake: Promise<Record<string, unknown>> | undefined;
  socket.onopen = () => {
    handshake = entry.options.connectionParams!();
  };
  socket.onmessage = (event) => {
    const result = JSON.parse(String(event.data)) as FormattedExecutionResult;
    for (const observer of entry.sinks) observer.next(result);
  };
  socket.dispatchEvent(new Event('open'));
  if (!handshake) throw new Error('Missing actual socket open context');
  const parameters = await handshake;
  return {
    socket,
    closed,
    parameters,
    deliver(result: FormattedExecutionResult) {
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(result) }));
    },
  };
}
function sink() {
  return { next: vi.fn(), error: vi.fn(), complete: vi.fn() };
}
async function settle() {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fixture.created = [];
  currentOwner = owner();
  clock = 0;
  let issued = 0;
  leaseFetch = vi.fn<typeof fetch>(async () =>
    Response.json({ status: 'admitted', token: `bsbd1_OWNED${++issued}`, usableForMs: 120_000, owner: currentOwner }),
  );
  fixture.browser = createBrowserBackendClient({
    ready: () => true,
    fetch: leaseFetch,
    endpoint: 'https://www.owned.test/api/internal/ws-auth',
    now: () => clock,
    schedule(callback, milliseconds) {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    },
  });
  fixture.browser.acceptSession(session());
});
afterEach(async () => {
  for (const entry of fixture.created) await entry.client.dispose();
  fixture.browser?.dispose();
  fixture.browser = null;
  vi.useRealTimers();
});

describe('WWW selected realtime adapter', () => {
  it('uses only the captured actual lease on handshake and guarded sink delivery', async () => {
    const current = await createSelectedClient();
    expect(current.parameters).toMatchObject({ authToken: 'bsbd1_OWNED1' });
    const observer = sink();
    current.client.subscribe({ query: 'subscription { viewer }' }, observer);
    current.deliver({ data: { viewer: 'owned-user-A' } });
    expect(observer.next).toHaveBeenCalledWith({ data: { viewer: 'owned-user-A' } });
    expect(leaseFetch).toHaveBeenCalledTimes(1);
  });
  it('proactively reconnects before expiry and obtains an actually renewed same-owner lease', async () => {
    const current = await createSelectedClient();
    clock = 90_000;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(current.entry.terminate).toHaveBeenCalledTimes(1);
    expect((await current.reconnect()).parameters).toMatchObject({ authToken: 'bsbd1_OWNED2' });
    expect(leaseFetch).toHaveBeenCalledTimes(2);
    await current.client.dispose();
    clock = 200_000;
    await vi.advanceTimersByTimeAsync(110_000);
    expect(current.entry.terminate).toHaveBeenCalledTimes(1);
  });
  it('expired same-owner4401 retries only after an actual admitted replacement', async () => {
    const current = await createSelectedClient();
    clock = 120_000; // A backgrounded page can miss its proactive timer.
    current.socket.dispatchEvent(new CloseEvent('close', { code: 4401 }));
    await settle();
    expect(leaseFetch).toHaveBeenCalledTimes(2);
    expect(current.closed.mock.calls[0][0].code).toBe(4403);
    const next = await current.reconnect();
    expect(next.parameters).toMatchObject({ authToken: 'bsbd1_OWNED2' });
    next.socket.send('owned-new-subscribe');
    expect(next.socket.sent).toEqual(['owned-new-subscribe']);
  });
  it('an unavailable expiry recovery stays4401 and never emits a replacement or anonymous frame', async () => {
    const current = await createSelectedClient();
    clock = 120_000;
    leaseFetch.mockResolvedValueOnce(Response.json({ status: 'unavailable' }, { status: 503 }));
    current.socket.dispatchEvent(new CloseEvent('close', { code: 4401 }));
    await settle();
    expect(current.closed.mock.calls[0][0].code).toBe(4401);
    expect(current.socket.sent).toEqual([]);
  });
  it('confirmed refusal of an unexpired lease retires this client scope without replay', async () => {
    const current = await createSelectedClient();
    current.socket.dispatchEvent(new CloseEvent('close', { code: 4401 }));
    await settle();
    expect(current.closed.mock.calls[0][0].code).toBe(4401);
    expect(current.client.dispose).toHaveBeenCalled();
    await expect(current.reconnect()).rejects.toMatchObject({ status: 'superseded' });
    expect(leaseFetch).toHaveBeenCalledTimes(1);
  });
  it('queued handshake and protocol frame from A cannot send after A to B to A', async () => {
    const current = await createSelectedClient();
    const handshake = current.reconnect();
    const frame = Promise.resolve().then(() => current.socket.send('stale-A-frame'));
    currentOwner = { ...owner(), userId: 'owned-user-B', cursor: { ...owner().cursor, version: 2 } };
    fixture.browser!.acceptSession(session(currentOwner));
    currentOwner = { ...owner(), cursor: { ...owner().cursor, version: 3 } };
    fixture.browser!.acceptSession(session(currentOwner));
    await expect(handshake).rejects.toMatchObject({ status: 'superseded' });
    await frame;
    expect(current.socket.sent).toEqual([]);
    expect(current.socket.closes).toContain(4401);
    expect(leaseFetch).toHaveBeenCalledTimes(1);
  });
  it('suppresses A delivery after B while B independently remains usable', async () => {
    const previous = await createSelectedClient();
    const oldSink = sink();
    previous.client.subscribe({ query: 'subscription { viewer }' }, oldSink);
    currentOwner = { ...owner(), userId: 'owned-user-B', cursor: { ...owner().cursor, version: 2 } };
    fixture.browser!.acceptSession(session(currentOwner));
    const next = await createSelectedClient();
    const nextSink = sink();
    next.client.subscribe({ query: 'subscription { viewer }' }, nextSink);
    previous.deliver({ data: { viewer: 'private-A' } });
    next.deliver({ data: { viewer: 'private-B' } });
    expect(oldSink.next).not.toHaveBeenCalled();
    expect(previous.socket.closes).toContain(4401);
    expect(nextSink.next).toHaveBeenCalledWith({ data: { viewer: 'private-B' } });
  });
  it('also refuses a delivery whose owner stayed the same but presented lease expired', async () => {
    const current = await createSelectedClient();
    const observer = sink();
    current.client.subscribe({ query: 'subscription { viewer }' }, observer);
    clock = 120_000;
    current.deliver({ data: { viewer: 'expired-result' } });
    expect(observer.next).not.toHaveBeenCalled();
    expect(current.socket.closes).toContain(4401);
  });
  it('preserves1013 uncertainty without downgrading or invalidating the current owner', async () => {
    const current = await createSelectedClient();
    current.socket.dispatchEvent(new CloseEvent('close', { code: 1013 }));
    expect(current.closed.mock.calls[0][0].code).toBe(1013);
    expect(leaseFetch).toHaveBeenCalledTimes(1);
    expect((await current.reconnect()).parameters).toMatchObject({ authToken: 'bsbd1_OWNED1' });
  });
  it('an expired socket cannot borrow a renewed socket receipt for queued send or delivery', async () => {
    const current = await createSelectedClient();
    const observer = sink();
    current.client.subscribe({ query: 'subscription { viewer }' }, observer);
    clock = 120_000;
    const next = await current.reconnect();
    expect(next.parameters.authToken).toBe('bsbd1_OWNED2');
    current.socket.send('old-socket-frame');
    current.deliver({ data: { viewer: 'old-socket-private-result' } });
    expect(current.socket.sent).toEqual([]);
    expect(observer.next).not.toHaveBeenCalled();
    next.socket.send('new-socket-frame');
    next.deliver({ data: { viewer: 'new-socket-current-result' } });
    expect(next.socket.sent).toEqual(['new-socket-frame']);
    expect(observer.next).toHaveBeenCalledWith({ data: { viewer: 'new-socket-current-result' } });
  });
  it('a late old-socket4401 cannot retire the currently admitted renewal scope', async () => {
    const current = await createSelectedClient();
    clock = 120_000;
    const next = await current.reconnect();
    const renewedToken = next.parameters.authToken as string;
    current.socket.dispatchEvent(new CloseEvent('close', { code: 4401 }));
    await settle();
    expect(current.closed.mock.calls[0][0].code).toBe(4401);
    expect(fixture.browser!.capture(renewedToken)).not.toBeNull();
    expect(current.client.dispose).not.toHaveBeenCalled();
    expect(leaseFetch).toHaveBeenCalledTimes(2);
    next.socket.send('current-after-old-close');
    expect(next.socket.sent).toEqual(['current-after-old-close']);
  });
  it('a superseded opening cannot assign a later socket or lease after its await', async () => {
    const current = await createSelectedClient();
    const earlier = current.reconnect();
    const latest = current.reconnect();
    await expect(earlier).rejects.toMatchObject({ status: 'superseded' });
    const last = await latest;
    expect(last.parameters.authToken).toBe('bsbd1_OWNED1');
    last.socket.send('only-latest-opening');
    expect(last.socket.sent).toEqual(['only-latest-opening']);
  });
  it('a sink invoked outside its actual receive frame cannot borrow the last valid delivery context', async () => {
    const current = await createSelectedClient();
    const observer = sink();
    current.client.subscribe({ query: 'subscription { viewer }' }, observer);
    current.deliver({ data: { viewer: 'current-frame' } });
    current.entry.sinks[0].next({ data: { viewer: 'unbound-callback' } });
    expect(observer.next).toHaveBeenCalledTimes(1);
    expect(observer.error).toHaveBeenCalledWith(expect.objectContaining({ status: 'superseded' }));
    expect(current.entry.releases[0]).toHaveBeenCalledTimes(1);
  });
});
