// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createSessionGuard, isSessionSuperseded, type SessionGuard } from '../session-guard';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
let handle: Handler;
const received: { url?: string; expectedViewer?: string; contentType?: string; authorization?: string }[] = [];
const server = createServer((request, response) => {
  received.push({
    url: request.url,
    expectedViewer: request.headers['x-boardsesh-expected-viewer'] as string | undefined,
    contentType: request.headers['content-type'],
    authorization: request.headers.authorization,
  });
  handle(request, response);
});
let pageOrigin: string;
// The same server on a different origin: localhost and 127.0.0.1 differ.
let otherOrigin: string;

const accountA = { userId: 'user-a', authSessionId: 'login-a' };

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

let requestSessionCheck: ReturnType<typeof vi.fn<() => void>>;

function guardOn(): SessionGuard {
  return createSessionGuard({
    reloadPage: vi.fn(),
    requestSessionCheck,
    pageOrigin: () => pageOrigin,
    recheckTimeoutMs: 100,
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  pageOrigin = `http://127.0.0.1:${address.port}`;
  otherOrigin = `http://localhost:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  received.length = 0;
  requestSessionCheck = vi.fn<() => void>();
  handle = (_request, response) => json(response, 200, { ok: true });
});

describe('expected-viewer header', () => {
  it('names the signed-in account on a same-origin request, by path, URL or Request', async () => {
    const guard = guardOn();
    guard.accept(accountA);

    await guard.fetch(`${pageOrigin}/api/internal/profile`);
    await guard.fetch(new URL('/api/internal/profile', pageOrigin));
    await guard.fetch(new Request(`${pageOrigin}/api/internal/profile`));

    expect(received.map((entry) => entry.expectedViewer)).toEqual([
      'user-a:login-a',
      'user-a:login-a',
      'user-a:login-a',
    ]);
  });

  it('resolves a relative path against the page origin', async () => {
    const guard = createSessionGuard({
      reloadPage: vi.fn(),
      requestSessionCheck,
      pageOrigin: () => pageOrigin,
      // The test runner has no page, so the relative path is resolved here, as a browser would.
      send: (input, init) => fetch(new URL(typeof input === 'string' ? input : '/unexpected', pageOrigin), init),
    });
    guard.accept(accountA);

    await guard.fetch('/api/internal/controllers');

    expect(received).toEqual([
      expect.objectContaining({ url: '/api/internal/controllers', expectedViewer: 'user-a:login-a' }),
    ]);
  });

  it('keeps the headers the caller set, from init or from a Request', async () => {
    const guard = guardOn();
    guard.accept(accountA);

    await guard.fetch(`${pageOrigin}/api/internal/controllers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    await guard.fetch(
      new Request(`${pageOrigin}/api/internal/controllers`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );

    expect(received).toEqual([
      expect.objectContaining({ contentType: 'application/json', expectedViewer: 'user-a:login-a' }),
      expect.objectContaining({ contentType: 'application/json', expectedViewer: 'user-a:login-a' }),
    ]);
  });

  it('names a signed-out page as anonymous', async () => {
    const guard = guardOn();
    guard.accept(null);

    await guard.fetch(`${pageOrigin}/api/internal/profile/user-a`);

    expect(received[0].expectedViewer).toBe('anonymous');
  });

  it('names nobody before the first session read is accepted, and leaves init untouched', async () => {
    const send = vi.fn<typeof fetch>((input, init) => fetch(input, init));
    const guard = createSessionGuard({ reloadPage: vi.fn(), requestSessionCheck, pageOrigin: () => pageOrigin, send });
    const init = { headers: { 'Content-Type': 'application/json' } };

    await guard.fetch(`${pageOrigin}/api/internal/profile`, init);

    expect(send.mock.calls[0][1]).toBe(init);
    expect(received[0].expectedViewer).toBeUndefined();
  });

  it('never sends it to another origin, such as the GraphQL backend', async () => {
    const guard = guardOn();
    guard.accept(accountA);

    await guard.fetch(`${otherOrigin}/graphql`, { headers: { Authorization: 'Bearer token-a' } });

    expect(received).toEqual([expect.objectContaining({ authorization: 'Bearer token-a', expectedViewer: undefined })]);
  });

  it('sends nothing when the page origin is unknown, as on the server', async () => {
    const guard = createSessionGuard({ reloadPage: vi.fn(), requestSessionCheck, pageOrigin: () => undefined });
    guard.accept(accountA);

    await guard.fetch(`${pageOrigin}/api/internal/profile`);

    expect(received[0].expectedViewer).toBeUndefined();
  });
});

describe('a 409 viewer_changed answer', () => {
  it('is superseded and asks for one immediate session check', async () => {
    const guard = guardOn();
    guard.accept(accountA);
    handle = (_request, response) => json(response, 409, { code: 'viewer_changed' });

    await expect(guard.fetch(`${pageOrigin}/api/internal/controllers`, { method: 'DELETE' })).rejects.toSatisfy(
      isSessionSuperseded,
    );

    // No delay, unlike a 401's coalescing timer.
    expect(requestSessionCheck).toHaveBeenCalledOnce();
    // The page keeps its account until the check proves the change.
    expect(guard.viewerKey()).toBe('user-a:login-a');
  });

  it('is told apart from any other 409, which reaches the caller as it was sent', async () => {
    const guard = guardOn();
    guard.accept(accountA);
    handle = (_request, response) => json(response, 409, { error: 'Password already set.' });

    const response = await guard.fetch(`${pageOrigin}/api/internal/set-password`, { method: 'POST' });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Password already set.' });
    expect(requestSessionCheck).not.toHaveBeenCalled();
  });

  // The session provider runs one probe for a burst (session-provider-guard.test.tsx).
  it('asks on every such answer and supersedes each of them', async () => {
    const guard = guardOn();
    guard.accept(accountA);
    handle = (_request, response) => json(response, 409, { code: 'viewer_changed' });

    const results = await Promise.allSettled([
      guard.fetch(`${pageOrigin}/api/internal/profile`),
      guard.fetch(`${pageOrigin}/api/internal/controllers`),
    ]);

    expect(results.every((result) => result.status === 'rejected' && isSessionSuperseded(result.reason))).toBe(true);
    expect(requestSessionCheck).toHaveBeenCalledTimes(2);
  });
});
