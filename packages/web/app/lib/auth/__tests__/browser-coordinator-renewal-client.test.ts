// @vitest-environment node
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { mountCanonicalBrowserCoordinator } from '@boardsesh/auth-protocol/browser-coordinator-dom';
import { BROWSER_COORDINATOR_LOCK } from '@boardsesh/auth-protocol/browser-coordinator';
import { renewCanonicalBrowserCoordinator, readCanonicalBrowserCoordinator } from '../browser-coordinator-client';

function requestPath(input: Parameters<typeof fetch>[0]): string {
  if (input instanceof URL) return input.pathname;
  return new URL(typeof input === 'string' ? input : input.url).pathname;
}
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.unstubAllGlobals();
});
it('joins the actual WWW wrapper to a retained frame and settled canonical renewal span', async () => {
  const origin = 'https://www.actual-wrapper.example.test';
  const current = { status: 'ready', cursor: { bindingId: 'a'.repeat(64), version: 3 } };
  const future = { status: 'ready', cursor: { ...current.cursor, version: 4 } };
  const canonical = new EventTarget();
  const parent = new EventTarget();
  const lockCalls: string[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  let active = 0;
  let maximumActive = 0;
  const locks = {
    request<Result>(name: string, options: LockOptions, operation: () => Promise<Result>) {
      lockCalls.push(name);
      const pending = tail.then(async () => {
        if (options.signal?.aborted) throw new Error('Aborted lock');
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await operation();
        } finally {
          active--;
        }
      });
      tail = pending.catch(() => {});
      return pending;
    },
  };
  let commitBody: ReadableStreamDefaultController<Uint8Array> | undefined;
  const send = vi.fn<typeof fetch>(async (input) => {
    const path = requestPath(input);
    if (path.endsWith('/renew/prepare'))
      return Response.json({ status: 'prepared', operationKey: 'b'.repeat(64), cursor: current.cursor });
    if (path.endsWith('/renew/commit'))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            commitBody = controller;
          },
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    if (path.endsWith('/observe')) return Response.json(commitBody ? future : current);
    throw new Error('Unexpected actual transport URL');
  });
  const canonicalWindow = Object.assign(canonical, {
    location: { origin },
    navigator: { locks },
    fetch: send,
    postMessage(message: unknown, targetOrigin: string, ports: readonly MessagePort[]) {
      expect(targetOrigin).toBe(origin);
      canonical.dispatchEvent(
        Object.assign(new Event('message'), {
          origin,
          source: parent,
          data: message,
          ports: [...ports],
        }),
      );
    },
  }) as unknown as Window;
  const frame = Object.assign(new EventTarget(), {
    hidden: false,
    referrerPolicy: '',
    src: '',
    contentWindow: canonicalWindow,
    setAttribute: vi.fn(),
    remove: vi.fn(),
  });
  const append = vi.fn((appended: EventTarget) => queueMicrotask(() => appended.dispatchEvent(new Event('load'))));
  const parentWindow = Object.assign(parent, {
    document: { createElement: vi.fn(() => frame), body: { append } },
  }) as unknown as Window;
  const host = mountCanonicalBrowserCoordinator({
    window: canonicalWindow,
    canonicalOrigin: origin,
    peers: [{ origin, source: parentWindow }],
    fetch: send,
  });
  cleanup.push(
    () => host.close(),
    () => parent.dispatchEvent(new Event('pagehide')),
  );
  vi.stubGlobal('window', parentWindow);
  const controller = new AbortController();
  const pending = renewCanonicalBrowserCoordinator(origin, controller.signal);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  expect(commitBody).toBeDefined();
  expect(lockCalls).toEqual([BROWSER_COORDINATOR_LOCK, BROWSER_COORDINATOR_LOCK]);
  expect(active).toBe(1);
  expect(maximumActive).toBe(1);
  commitBody!.enqueue(new TextEncoder().encode(JSON.stringify(future)));
  commitBody!.close();
  expect(await pending).toBeUndefined();
  const paths = send.mock.calls.map(([input]) => requestPath(input));
  expect(paths).toEqual([
    '/api/internal/auth/browser-coordinator/observe',
    '/api/internal/auth/browser-coordinator/renew/prepare',
    '/api/internal/auth/browser-coordinator/renew/commit',
    '/api/internal/auth/browser-coordinator/observe',
  ]);
  expect(active).toBe(0);
  expect(append).toHaveBeenCalledOnce();
  await readCanonicalBrowserCoordinator(origin, controller.signal);
  expect(append).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledTimes(5);
  expect(lockCalls).toEqual(Array(3).fill(BROWSER_COORDINATOR_LOCK));
  expect(maximumActive).toBe(1);
});
