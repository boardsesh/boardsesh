import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { connectBrowserCoordinatorClient } from '../browser-coordinator-channel';
import { browserCoordinatorPort, mountCanonicalBrowserCoordinator } from '../browser-coordinator-dom';
import { BROWSER_COORDINATOR_LOCK } from '../browser-coordinator-v1';

const canonical = 'https://www.boardsesh.test';
const app = 'https://app.boardsesh.test';
const ready = { status: 'ready', cursor: { bindingId: 'a'.repeat(64), version: 0 } } as const;
const realSchedule = setTimeout;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.useRealTimers();
});
async function flush() {
  for (let index = 0; index < 8; index++) await new Promise<void>((resolve) => realSchedule(resolve, 0));
}
function fixture() {
  const owner = new EventTarget();
  const peer = {} as Window;
  const tails = new Map<string, Promise<unknown>>();
  const locks = vi.fn(<Result>(name: string, options: LockOptions, operation: () => Promise<Result>) => {
    const prior = tails.get(name) ?? Promise.resolve();
    const result = prior
      .catch(() => {})
      .then(() => {
        if (options.signal?.aborted) throw new Error('LOCK_ABORTED');
        return operation();
      });
    tails.set(
      name,
      result.catch(() => {}),
    );
    return result;
  });
  const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(ready));
  const browser = Object.assign(owner, {
    location: { origin: canonical },
    navigator: { locks: { request: locks } },
    fetch: send,
  }) as unknown as Window;
  const host = mountCanonicalBrowserCoordinator({
    window: browser,
    canonicalOrigin: canonical,
    peers: [{ origin: app, source: peer }],
    fetch: send,
  });
  cleanup.push(host.close);
  const posted: unknown[] = [];
  const connect = (origin = app, source = peer) =>
    connectBrowserCoordinatorClient({
      canonicalOrigin: canonical,
      target: browser,
      timeoutMs: 15_000,
      platform: {
        createChannel() {
          const channel = new MessageChannel();
          return { local: browserCoordinatorPort(channel.port1), remote: channel.port2 };
        },
        postConnect(target, exactOrigin, message, remote) {
          expect(target).toBe(browser);
          expect(exactOrigin).toBe(canonical);
          posted.push(message);
          owner.dispatchEvent(Object.assign(new Event('message'), { origin, source, data: message, ports: [remote] }));
        },
        newId: () => crypto.randomUUID(),
        schedule(callback, milliseconds) {
          const timer = setTimeout(callback, milliseconds);
          return () => clearTimeout(timer);
        },
      },
    });
  return { browser, owner, peer, host, send, locks, posted, connect };
}
describe('actual browser coordinator platform adapter', () => {
  it('uses real MessagePorts and fixed credentialed endpoints for observe-initialize-confirm', async () => {
    const current = fixture();
    current.send
      .mockResolvedValueOnce(Response.json({ status: 'missing-binding' }))
      .mockResolvedValueOnce(Response.json(ready))
      .mockResolvedValueOnce(Response.json(ready));
    const client = await current.connect();
    cleanup.push(() => client.close());
    expect(await client.request({ operation: 'read' })).toEqual(ready);
    expect(
      current.send.mock.calls.map(([url]) => {
        if (!(url instanceof URL)) throw new Error('Expected fixed URL');
        return url.href;
      }),
    ).toEqual([
      `${canonical}/api/internal/auth/browser-coordinator/observe`,
      `${canonical}/api/internal/auth/browser-coordinator/initialize`,
      `${canonical}/api/internal/auth/browser-coordinator/observe`,
    ]);
    for (const [, init] of current.send.mock.calls)
      expect(init).toMatchObject({
        credentials: 'include',
        keepalive: false,
        cache: 'no-store',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      });
    expect(current.send.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{}' });
    expect(current.locks.mock.calls.map(([name]) => name)).toEqual([BROWSER_COORDINATOR_LOCK]);
    expect(JSON.stringify(current.posted)).not.toMatch(/credential|userId|token|password|url/i);
  });
  it.each(['origin', 'source'] as const)('rejects the wrong exact %s before any network request', async (mismatch) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const current = fixture();
    const pending = current.connect(
      mismatch === 'origin' ? 'https://app.boardsesh.test.evil.test' : app,
      mismatch === 'source' ? ({} as Window) : current.peer,
    );
    const rejected = expect(pending).rejects.toThrow('COORDINATOR_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(current.send).not.toHaveBeenCalled();
  });
  it('retains the common lock through an abort-ignoring body until actual settlement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const current = fixture();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    current.send.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const first = await current.connect();
    cleanup.push(() => first.close());
    const second = await current.connect();
    cleanup.push(() => second.close());
    const pending = first.request({ operation: 'read' });
    await flush();
    expect(current.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toEqual({ status: 'unavailable' });
    const later = second.request({ operation: 'read' });
    await flush();
    expect(current.send).toHaveBeenCalledTimes(1);
    expect(current.send.mock.calls[0][1]?.signal?.aborted).toBe(true);
    stream.enqueue(new TextEncoder().encode(JSON.stringify(ready)));
    stream.close();
    await flush();
    expect(await later).toEqual(ready);
    expect(current.send).toHaveBeenCalledTimes(2);
    expect(current.locks.mock.calls.every(([name]) => name === BROWSER_COORDINATOR_LOCK)).toBe(true);
  });
  it.each([
    () => Response.json({ ...ready, token: 'private-token' }),
    () => Response.json(ready, { status: 503 }),
    () => new Response('x'.repeat(8_193), { headers: { 'Content-Type': 'application/json' } }),
  ])('refuses malformed or private-bearing metadata without initialization fallback', async (badResponse) => {
    const current = fixture();
    current.send.mockResolvedValueOnce(badResponse());
    const client = await current.connect();
    cleanup.push(() => client.close());
    expect(await client.request({ operation: 'read' })).toEqual({ status: 'unavailable' });
    expect(current.send).toHaveBeenCalledTimes(1);
  });
  it('requires the actual canonical origin and browser lock support', () => {
    const current = fixture();
    expect(() =>
      mountCanonicalBrowserCoordinator({
        window: { location: { origin: app } } as Window,
        canonicalOrigin: canonical,
        peers: [],
      }),
    ).toThrow();
    expect(() =>
      mountCanonicalBrowserCoordinator({
        window: { location: { origin: canonical }, navigator: {} } as Window,
        canonicalOrigin: canonical,
        peers: [],
      }),
    ).toThrow();
    current.host.close();
    current.owner.dispatchEvent(new Event('pagehide'));
  });
});
