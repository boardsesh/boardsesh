/**
 * The Expo web page latch and its session re-reads (#7596), against a real
 * local HTTP server standing in for www's auth endpoints. Each test opens a
 * fresh "page": new module memory, a window that is a real EventTarget, and a
 * BroadcastChannel shared with an optional peer tab.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthTokenChangeSource } from '../auth-token-change-types';

vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '2.6.0' } } }));

type Identity = { userId: string; authSessionId: string } | null;

const USER_A = { userId: 'user-a', authSessionId: 'login-a' };
const USER_B = { userId: 'user-b', authSessionId: 'login-b' };
const APP_ORIGIN = 'https://app.boardsesh.test';

const site = {
  cookie: USER_A as Identity,
  sessionBody: null as unknown,
  sessionStatus: 200,
  hits: [] as string[],
};

let server: Server;
let origin = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const path = request.url ?? '';
    site.hits.push(path);
    request.resume();
    if (path === '/api/auth/session') {
      if (site.sessionStatus !== 200) return send(site.sessionStatus, {});
      if (site.sessionBody !== null) return send(200, site.sessionBody);
      return send(
        200,
        site.cookie ? { user: { id: site.cookie.userId }, authSessionId: site.cookie.authSessionId } : {},
      );
    }
    if (path === '/api/internal/ws-auth') {
      if (!site.cookie) return send(200, { authenticated: false, token: null });
      return send(200, { authenticated: true, token: `jwe:${site.cookie.userId}`, ...site.cookie });
    }
    if (path === '/api/auth/csrf') return send(200, { csrfToken: 'csrf-token' });
    if (path === '/api/auth/signout') {
      site.cookie = null;
      return send(200, { url: `${APP_ORIGIN}/` });
    }
    send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type MessageListener = (event: MessageEvent<unknown>) => void;

class MockBroadcastChannel {
  static channels: MockBroadcastChannel[] = [];
  private readonly listeners = new Set<MessageListener>();

  constructor(readonly name: string) {
    MockBroadcastChannel.channels.push(this);
  }

  addEventListener(type: string, listener: MessageListener): void {
    if (type === 'message') this.listeners.add(listener);
  }

  postMessage(message: unknown): void {
    for (const channel of MockBroadcastChannel.channels) {
      if (channel === this || channel.name !== this.name) continue;
      for (const listener of channel.listeners) listener({ data: message } as MessageEvent<unknown>);
    }
  }
}

type Page = {
  store: typeof import('../auth-store.web');
  retirement: typeof import('../browser-page-retirement.web');
  window: EventTarget & { location: { origin: string; replace: ReturnType<typeof vi.fn> } };
  sources: AuthTokenChangeSource[];
};

async function openPage(cookie: Identity = USER_A): Promise<Page> {
  vi.resetModules();
  vi.stubEnv('EXPO_PUBLIC_WEB_URL', origin);
  const pageWindow = Object.assign(new EventTarget(), { location: { origin: APP_ORIGIN, replace: vi.fn() } });
  vi.stubGlobal('window', pageWindow);
  site.cookie = cookie;
  const store = await import('../auth-store.web');
  const retirement = await import('../browser-page-retirement.web');
  await store.synchronizeWebSession();
  const sources: AuthTokenChangeSource[] = [];
  store.subscribeAuthTokenChanges((_token, source) => sources.push(source));
  return { store, retirement, window: pageWindow, sources };
}

function peerChannel(): MockBroadcastChannel {
  return new MockBroadcastChannel('boardsesh-expo-web-auth-v1');
}

function dispatchPageShow(target: EventTarget, persisted: boolean): void {
  target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));
}

beforeEach(() => {
  MockBroadcastChannel.channels = [];
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
  site.sessionBody = null;
  site.sessionStatus = 200;
  site.hits = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Expo web page latch', () => {
  it('latches the first signed-in login and stays live across same-login reads', async () => {
    const page = await openPage();
    await page.store.synchronizeWebSession();

    expect(page.retirement.hasBrowserPageIdentity()).toBe(true);
    expect(page.retirement.isBrowserPageRetired()).toBe(false);
  });

  it.each([
    ['another account', USER_B],
    ['the same account on a new login', { userId: USER_A.userId, authSessionId: 'login-a2' }],
    ['a signed-out cookie', null],
  ] as const)('retires when the cookie moves to %s', async (_case, next) => {
    const page = await openPage();
    site.cookie = next;

    await page.store.synchronizeWebSession();

    expect(page.retirement.isBrowserPageRetired()).toBe(true);
  });

  it('stays live through an outage and a malformed session, then the same login', async () => {
    const page = await openPage();
    site.sessionStatus = 503;
    await expect(page.store.synchronizeWebSession()).resolves.toEqual(
      expect.objectContaining({ status: 'unavailable' }),
    );
    site.sessionStatus = 200;
    site.sessionBody = { user: { id: USER_A.userId } };
    await page.store.synchronizeWebSession();
    site.sessionBody = null;
    await page.store.synchronizeWebSession();

    expect(page.retirement.isBrowserPageRetired()).toBe(false);
  });

  it('latches a sign-in on a signed-out page without retiring it', async () => {
    const page = await openPage(null);
    expect(page.retirement.hasBrowserPageIdentity()).toBe(false);
    site.cookie = USER_A;

    await page.store.synchronizeWebSession();

    expect(page.retirement.hasBrowserPageIdentity()).toBe(true);
    expect(page.retirement.isBrowserPageRetired()).toBe(false);
  });

  it("retires on another tab's confirmed sign-out of this login, not on its sign-out start", async () => {
    const page = await openPage();
    const peer = peerChannel();

    peer.postMessage({ type: 'auth-token-cleared', sourceId: 'peer', reason: 'signout-started', identity: USER_A });
    expect(page.retirement.isBrowserPageRetired()).toBe(false);
    // www's tabs post on the same channel with their own source id.
    peer.postMessage({
      type: 'auth-token-cleared',
      sourceId: 'nextauth-web',
      reason: 'confirmed-signout',
      identity: USER_A,
    });

    expect(page.retirement.isBrowserPageRetired()).toBe(true);
    expect(page.sources).toContain('remote-signout');
  });

  it('retires after this page confirms its own sign-out', async () => {
    const page = await openPage();
    const auth = await import('../auth.web');

    await expect(auth.signOutForGeneration(page.store.captureAuthCredentialGeneration())).resolves.toBe(true);

    expect(page.retirement.isBrowserPageRetired()).toBe(true);
  });
});

describe('Expo web session re-reads', () => {
  it('re-reads on focus through ws-auth at most every 30 s and asks for a full read only on a change', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
    const page = await openPage();
    site.hits = [];
    const focus = () => page.window.dispatchEvent(new Event('focus'));

    vi.setSystemTime(new Date('2026-11-16T12:00:10Z'));
    focus();
    vi.setSystemTime(new Date('2026-11-16T12:00:31Z'));
    focus();
    await vi.waitFor(() => expect(site.hits).toEqual(['/api/internal/ws-auth']));
    expect(page.sources).toEqual([]);

    site.cookie = USER_B;
    vi.setSystemTime(new Date('2026-11-16T12:00:40Z'));
    focus();
    vi.setSystemTime(new Date('2026-11-16T12:01:02Z'));
    focus();

    await vi.waitFor(() => expect(page.sources).toEqual(['hint']));
    // Only the cookie-free probe ran; the provider's full read follows the hint.
    expect(site.hits).toEqual(['/api/internal/ws-auth', '/api/internal/ws-auth']);
  });

  it('re-reads a page restored from the back/forward cache at once', async () => {
    const page = await openPage();
    site.hits = [];
    site.cookie = USER_B;

    dispatchPageShow(page.window, false);
    expect(site.hits).toEqual([]);
    dispatchPageShow(page.window, true);

    await vi.waitFor(() => expect(page.sources).toEqual(['hint']));
    expect(site.hits).toEqual(['/api/internal/ws-auth']);
  });

  it('reloads a retired page restored from the back/forward cache from the app root', async () => {
    vi.stubEnv('EXPO_BASE_URL', '/app');
    const page = await openPage();
    site.cookie = USER_B;
    await page.store.synchronizeWebSession();
    site.hits = [];

    dispatchPageShow(page.window, true);

    expect(page.window.location.replace).toHaveBeenCalledWith(`${APP_ORIGIN}/app`);
    expect(site.hits).toEqual([]);
  });

  it('leaves a restored page that never signed in alone', async () => {
    const page = await openPage(null);
    site.hits = [];

    dispatchPageShow(page.window, true);

    expect(site.hits).toEqual([]);
    expect(page.window.location.replace).not.toHaveBeenCalled();
  });
});
