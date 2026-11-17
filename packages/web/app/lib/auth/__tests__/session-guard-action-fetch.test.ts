// @vitest-environment node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createSessionGuard,
  isReloadRequired,
  isSessionSuperseded,
  isWriteRefused,
  type SessionGuard,
  type SessionViewer,
} from '../session-guard';

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
let handle: Handler;
const received: { method?: string; expectedViewer?: string }[] = [];
const server = createServer((request, response) => {
  received.push({ method: request.method, expectedViewer: request.headers['x-boardsesh-expected-viewer'] as string });
  void handle(request, response);
});
let pageOrigin: string;

const loginA = { userId: 'user-a', authSessionId: 'login-a' };
const loginA2 = { userId: 'user-a', authSessionId: 'login-a2' };
const accountB = { userId: 'user-b', authSessionId: 'login-b' };

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}
const refuse = (response: ServerResponse) =>
  json(response, 409, { code: 'viewer_changed', error: 'Reload this page.' });

/** The route's check, against a cookie the test moves. */
let cookieViewer: string;
function routeChecks(request: IncomingMessage, response: ServerResponse) {
  if (request.headers['x-boardsesh-expected-viewer'] === cookieViewer) json(response, 200, { ok: true });
  else refuse(response);
}

let reloadPage: ReturnType<typeof vi.fn<() => void>>;
let guard: SessionGuard;
/** What the session provider does when the guard asks for a check: set per test. */
let onCheck: () => void;
let checks: number;

function pageShowing(viewer: SessionViewer) {
  checks = 0;
  const page = createSessionGuard({
    reloadPage,
    requestSessionCheck: () => {
      checks += 1;
      // The provider answers later: a probe, then maybe a session read. A check
      // an earlier case's page asked for never reaches this case.
      setTimeout(() => {
        if (guard === page) onCheck();
      }, 5);
    },
    pageOrigin: () => pageOrigin,
    cleanupTimeoutMs: 10,
    recheckTimeoutMs: 2000,
  });
  guard = page;
  guard.accept(viewer);
}

const controllers = () => `${pageOrigin}/api/internal/controllers`;
const register = () => guard.actionFetch(controllers(), { method: 'POST', body: '{"boardName":"spray"}' });

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  pageOrigin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  received.length = 0;
  reloadPage = vi.fn<() => void>();
  handle = routeChecks;
  cookieViewer = 'user-a:login-a';
  // A probe started after the refusal finds the page's own login.
  onCheck = () => guard.sessionChecked(guard.sessionReadStarted());
});

describe('a new login of the same account elsewhere', () => {
  beforeEach(() => {
    pageShowing(loginA);
    cookieViewer = 'user-a:login-a2';
    // The probe sees login-a2, so the provider reads and accepts it.
    onCheck = () => guard.accept(loginA2);
  });

  it.each(['GET', 'DELETE'])('sends a %s once more, under the new login, after the re-check', async (method) => {
    const response = await guard.actionFetch(controllers(), { method, body: method === 'GET' ? undefined : '{}' });

    expect(response.status).toBe(200);
    expect(received.map((entry) => entry.expectedViewer)).toEqual(['user-a:login-a', 'user-a:login-a2']);
    expect(checks).toBe(1);
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('never sends a write twice: the first refusal asks for another press, which goes through', async () => {
    await expect(register()).rejects.toSatisfy(isWriteRefused);
    expect(received).toHaveLength(1);

    const response = await register();

    expect(response.status).toBe(200);
    expect(received.map((entry) => entry.expectedViewer)).toEqual(['user-a:login-a', 'user-a:login-a2']);
  });

  it('asks for a reload when a write’s answer was lost to the new login, since it may have committed', async () => {
    cookieViewer = 'user-a:login-a';
    let finish = () => {};
    handle = (request, response) => {
      finish = () => routeChecks(request, response);
    };
    const pending = register();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    // The focus probe saw the new login while the write was out.
    guard.accept(loginA2);
    finish();

    await expect(pending).rejects.toSatisfy(isReloadRequired);
    expect(received).toHaveLength(1);
  });
});

describe('a re-check that changes nothing (the page and the server disagree)', () => {
  beforeEach(() => {
    pageShowing(loginA);
    handle = (_request, response) => refuse(response);
  });

  it.each(['GET', 'DELETE'])(
    'asks for a reload once the %s retry is refused too, after one retry only',
    async (method) => {
      await expect(guard.actionFetch(controllers(), { method })).rejects.toSatisfy(isReloadRequired);

      expect(received).toHaveLength(2);
    },
  );

  it('asks for a reload on the second refused press of the same write, not the first', async () => {
    await expect(register()).rejects.toSatisfy(isWriteRefused);
    await expect(register()).rejects.toSatisfy(isReloadRequired);

    expect(received).toHaveLength(2);
  });

  it('counts a write afresh once any action was answered', async () => {
    await expect(register()).rejects.toSatisfy(isWriteRefused);
    handle = (_request, response) => json(response, 200, { ok: true });
    expect((await guard.actionFetch(controllers())).status).toBe(200);
    handle = (_request, response) => refuse(response);

    await expect(register()).rejects.toSatisfy(isWriteRefused);
  });

  it('counts a write afresh after the viewer moved, so refusals hours apart never add up', async () => {
    await expect(register()).rejects.toSatisfy(isWriteRefused);
    // A later re-login of the same account elsewhere, seen by a focus probe.
    guard.accept(loginA2);

    await expect(register()).rejects.toSatisfy(isWriteRefused);
  });

  it('is not released by a session read that started before the refusal', async () => {
    // This case's page, so its timers never reach the next case's guard.
    const page = guard;
    const startedEarlier = page.sessionReadStarted();
    let probeReported = false;
    let retriedAfterProbe: boolean | undefined;
    onCheck = () => {
      // A read already out lands with the old login; the probe asked for reports later.
      page.accept(loginA, startedEarlier);
      setTimeout(() => {
        probeReported = true;
        page.sessionChecked(page.sessionReadStarted());
      }, 40);
    };
    handle = (_request, response) => {
      if (received.length === 2) retriedAfterProbe = probeReported;
      refuse(response);
    };

    await expect(guard.actionFetch(controllers())).rejects.toSatisfy(isReloadRequired);

    expect(retriedAfterProbe).toBe(true);
  });

  it('is not released by a probe that started before the refusal', async () => {
    const startedEarlier = guard.sessionReadStarted();
    onCheck = () => guard.sessionChecked(startedEarlier);
    guard = createSessionGuard({
      reloadPage,
      requestSessionCheck: () => setTimeout(onCheck, 5),
      pageOrigin: () => pageOrigin,
      recheckTimeoutMs: 60,
    });
    guard.accept(loginA);
    const waited = Date.now();

    await expect(guard.actionFetch(controllers())).rejects.toSatisfy(isReloadRequired);

    // Only the timeout released it.
    expect(Date.now() - waited).toBeGreaterThanOrEqual(50);
  });

  it('stops waiting when the provider never reports, then retries once', async () => {
    onCheck = () => {};
    guard = createSessionGuard({
      reloadPage,
      requestSessionCheck: () => onCheck(),
      pageOrigin: () => pageOrigin,
      recheckTimeoutMs: 30,
    });
    guard.accept(loginA);

    await expect(guard.actionFetch(controllers())).rejects.toSatisfy(isReloadRequired);
    expect(received).toHaveLength(2);
  });
});

describe('another account elsewhere', () => {
  it.each(['GET', 'POST'])('a %s shows nothing and is not sent again: the page reloads', async (method) => {
    pageShowing(loginA);
    cookieViewer = 'user-b:login-b';
    onCheck = () => guard.accept(accountB);

    await expect(guard.actionFetch(controllers(), { method })).rejects.toSatisfy(isSessionSuperseded);

    expect(received).toHaveLength(1);
    await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledOnce());
  });
});

it('passes every other answer through untouched', async () => {
  pageShowing(loginA);
  handle = (_request, response) => json(response, 409, { error: 'Controller is in use' });

  const response = await guard.actionFetch(controllers(), { method: 'DELETE' });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'Controller is in use' });
  expect(received).toHaveLength(1);
  expect(checks).toBe(0);
});
