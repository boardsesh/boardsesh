// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  browserCoordinatorConnectSchema,
  browserCoordinatorRequestSchema,
} from '@boardsesh/auth-protocol/browser-coordinator';

const realSchedule = setTimeout;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function flush() {
  for (let index = 0; index < 8; index++) await new Promise<void>((resolve) => realSchedule(resolve, 0));
}
function fixture(acknowledge = true) {
  let connectOverride: ((input: unknown, port: MessagePort, source: object) => void) | null = null;
  const created: (EventTarget & { remove: ReturnType<typeof vi.fn> })[] = [];
  const requests: unknown[] = [];
  const ports: MessagePort[] = [];
  const append = vi.fn();
  const owner = Object.assign(new EventTarget(), {
    document: {
      createElement() {
        const frame = Object.assign(new EventTarget(), {
          setAttribute: vi.fn(),
          remove: vi.fn(),
          src: '',
          hidden: false,
          referrerPolicy: '',
          contentWindow: {
            postMessage(input: unknown, origin: string, transferred: MessagePort[]) {
              expect(origin).toBe('https://www.boardsesh.test');
              const greeting = browserCoordinatorConnectSchema.parse(input);
              const port = transferred[0];
              ports.push(port);
              if (connectOverride) {
                connectOverride(input, port, owner);
                return;
              }
              port.addEventListener('message', (event: MessageEvent<unknown>) => {
                const request = browserCoordinatorRequestSchema.safeParse(event.data);
                if (request.success) requests.push(request.data);
                // Deliberately withhold result: cancellation cannot prove that
                // the canonical host's actual network work has settled.
              });
              port.start();
              if (acknowledge) port.postMessage({ ...greeting, type: 'connected' });
            },
          },
        });
        created.push(frame);
        return frame;
      },
      body: { append },
    },
  });
  vi.stubGlobal('window', owner);
  cleanup.push(() => {
    owner.dispatchEvent(new Event('pagehide'));
    for (const port of ports) port.close();
  });
  return {
    owner,
    created,
    append,
    requests,
    setConnectOverride: (receive: NonNullable<typeof connectOverride>) => {
      connectOverride = receive;
    },
  };
}
describe('owned canonical frame lifetime', () => {
  it.each(['error', 'deadline', 'handshake'] as const)(
    'rebuilds after a %s before any metadata request',
    async (failure) => {
      vi.resetModules();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { readCanonicalBrowserCoordinator } = await import('../browser-coordinator-client');
      const current = fixture(failure !== 'handshake');
      const first = readCanonicalBrowserCoordinator('https://www.boardsesh.test', new AbortController().signal);
      const rejected = expect(first).rejects.toThrow('COORDINATOR_UNAVAILABLE');
      if (failure === 'error') current.created[0].dispatchEvent(new Event('error'));
      else {
        if (failure === 'handshake') {
          current.created[0].dispatchEvent(new Event('load'));
          await flush();
        }
        await vi.advanceTimersByTimeAsync(15_000);
      }
      await rejected;
      expect(current.created[0].remove).toHaveBeenCalledTimes(1);
      const later = readCanonicalBrowserCoordinator('https://www.boardsesh.test', new AbortController().signal);
      current.created[1].dispatchEvent(new Event('error'));
      await expect(later).rejects.toThrow('COORDINATOR_UNAVAILABLE');
      expect(current.created).toHaveLength(2);
      expect(current.append).toHaveBeenCalledTimes(2);
      expect(current.requests).toHaveLength(0);
    },
  );
  it('retains a frame after a request timeout while cookie work may still be settling', async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { readCanonicalBrowserCoordinator } = await import('../browser-coordinator-client');
    const current = fixture();
    const first = readCanonicalBrowserCoordinator('https://www.boardsesh.test', new AbortController().signal);
    const rejected = expect(first).rejects.toThrow('COORDINATOR_UNAVAILABLE');
    current.created[0].dispatchEvent(new Event('load'));
    await flush();
    expect(current.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(current.created[0].remove).not.toHaveBeenCalled();
    const later = readCanonicalBrowserCoordinator('https://www.boardsesh.test', new AbortController().signal);
    const laterRejected = expect(later).rejects.toThrow('COORDINATOR_UNAVAILABLE');
    await flush();
    expect(current.requests).toHaveLength(2);
    expect(current.created).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await laterRejected;
    expect(current.created[0].remove).not.toHaveBeenCalled();
  });
  it('retains the actual host and lock through a timed-out deferred HTTP body', async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { readCanonicalBrowserCoordinator } = await import('../browser-coordinator-client');
    const { mountCanonicalBrowserCoordinator } = await import('@boardsesh/auth-protocol/browser-coordinator-dom');
    const current = fixture();
    const host = new EventTarget();
    let tail: Promise<unknown> = Promise.resolve();
    const request = <Result>(_name: string, _options: LockOptions, run: () => Promise<Result>) => {
      const result = tail.then(run, run);
      tail = result.catch(() => {});
      return result;
    };
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const ready = { status: 'ready', cursor: { bindingId: 'a'.repeat(64), version: 1 } };
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockImplementation(async () => Response.json(ready));
    const hostWindow = Object.assign(host, {
      location: { origin: 'https://www.boardsesh.test' },
      navigator: { locks: { request } },
    }) as unknown as Window;
    const mounted = mountCanonicalBrowserCoordinator({
      window: hostWindow,
      canonicalOrigin: 'https://www.boardsesh.test',
      peers: [{ origin: 'https://www.boardsesh.test', source: current.owner as unknown as Window }],
      fetch: send,
    });
    cleanup.push(mounted.close);
    current.setConnectOverride((input, port, source) =>
      host.dispatchEvent(
        Object.assign(new Event('message'), {
          data: input,
          ports: [port],
          source,
          origin: 'https://www.boardsesh.test',
        }),
      ),
    );
    const first = readCanonicalBrowserCoordinator('https://www.boardsesh.test', new AbortController().signal);
    const rejected = expect(first).rejects.toThrow('COORDINATOR_UNAVAILABLE');
    current.created[0].dispatchEvent(new Event('load'));
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    const later = readCanonicalBrowserCoordinator('https://www.boardsesh.test', new AbortController().signal);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(current.created).toHaveLength(1);
    expect(current.created[0].remove).not.toHaveBeenCalled();
    body.enqueue(new TextEncoder().encode(JSON.stringify(ready)));
    body.close();
    await expect(later).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
