/**
 * The Expo web transport guard (#7596) against a real local HTTP server and the
 * real fetch: www's session + ws-auth endpoints and the backend's /graphql, with
 * the shared cookie modelled as server state. Nothing here scripts a readiness
 * gate; the code runs in today's legacy mode.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '2.6.0' } } }));
vi.mock('../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
// Vitest has no `.web` resolution; Metro gives client-default the web interceptor.
vi.mock('../auth-interceptor', () => import('../auth-interceptor.web'));

type Identity = { userId: string; authSessionId: string } | null;

const USER_A = { userId: 'user-a', authSessionId: 'login-a' };
const USER_B = { userId: 'user-b', authSessionId: 'login-b' };

const site = {
  cookie: USER_A as Identity,
  // Overrides the session body, e.g. a signed-in session without its login id.
  sessionBody: null as unknown,
  sessionStatus: 200,
  graphqlStatus: [] as number[],
  hold: false,
  held: [] as (() => void)[],
  graphqlAuthorizations: [] as (string | null)[],
};

let server: Server;
let origin = '';

function tokenFor(identity: NonNullable<Identity>): string {
  return `jwe:${identity.userId}:${identity.authSessionId}`;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const path = request.url ?? '';
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
      return send(200, { authenticated: true, token: tokenFor(site.cookie), ...site.cookie });
    }
    if (path === '/graphql') {
      const authorization = request.headers.authorization ?? null;
      site.graphqlAuthorizations.push(authorization);
      request.resume();
      const status = site.graphqlStatus.shift() ?? 200;
      const answer = () => send(status, status === 200 ? { data: { viewer: authorization } } : { errors: [] });
      if (site.hold) site.held.push(answer);
      else answer();
      return;
    }
    send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const answer of site.held.splice(0)) answer();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Modules = {
  store: typeof import('../auth-store.web');
  interceptor: typeof import('../auth-interceptor.web');
  guard: typeof import('../browser-session-guard.web');
  retirement: typeof import('../browser-page-retirement.web');
};

let modules: Modules;

/** A fresh page: new module memory, cookie set to A, signed in. */
async function openPage(cookie: Identity = USER_A): Promise<Modules> {
  vi.resetModules();
  vi.stubEnv('EXPO_PUBLIC_WEB_URL', origin);
  vi.stubEnv('EXPO_PUBLIC_BACKEND_URL', origin);
  site.cookie = cookie;
  modules = {
    store: await import('../auth-store.web'),
    interceptor: await import('../auth-interceptor.web'),
    guard: await import('../browser-session-guard.web'),
    retirement: await import('../browser-page-retirement.web'),
  };
  await modules.store.synchronizeWebSession();
  return modules;
}

function sendGraphql(): Promise<Response> {
  return modules.interceptor.authenticatedFetch(`${origin}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ viewer }' }),
  });
}

async function switchCookieTo(identity: Identity): Promise<void> {
  site.cookie = identity;
  await modules.store.synchronizeWebSession();
}

const superseded = () => expect.objectContaining({ name: 'AbortError', code: 'superseded' });

beforeEach(() => {
  site.sessionBody = null;
  site.sessionStatus = 200;
  site.graphqlStatus = [];
  site.hold = false;
  site.held = [];
  site.graphqlAuthorizations = [];
});

describe('Expo web transport guard', () => {
  it('turns a response held across an account switch into SessionSupersededError', async () => {
    await openPage();
    site.hold = true;
    const heldRequest = sendGraphql();
    await vi.waitFor(() => expect(site.held).toHaveLength(1));

    await switchCookieTo(USER_B);
    site.held.shift()?.();

    const outcome = await heldRequest.catch((error: unknown) => error);
    expect(modules.guard.isSessionSupersededError(outcome)).toBe(true);
    expect(outcome).toEqual(superseded());
    expect(site.graphqlAuthorizations).toEqual([`Bearer ${tokenFor(USER_A)}`]);
    expect(modules.retirement.isBrowserPageRetired()).toBe(true);
  });

  it('keeps checking body reads after the caller already holds the response', async () => {
    await openPage();
    const response = await sendGraphql();

    await switchCookieTo(USER_B);

    await expect(response.json()).rejects.toEqual(superseded());
    expect(() => response.clone()).toThrow(modules.guard.SessionSupersededError);
    expect(() => response.body).toThrow(modules.guard.SessionSupersededError);
  });

  it('sends nothing from a retired page', async () => {
    await openPage();
    await switchCookieTo(null);
    expect(modules.retirement.isBrowserPageRetired()).toBe(true);

    await expect(sendGraphql()).rejects.toEqual(superseded());
    expect(site.graphqlAuthorizations).toEqual([]);
  });

  it('drops an anonymous answer when this page signs in, and keeps the page live', async () => {
    await openPage(null);
    site.hold = true;
    const anonymousRequest = sendGraphql();
    await vi.waitFor(() => expect(site.held).toHaveLength(1));

    // The in-page sign-in: the callback fences the old credential, then the
    // session read confirms A.
    await modules.store.clearTokens();
    await switchCookieTo(USER_A);
    site.held.shift()?.();
    site.hold = false;

    await expect(anonymousRequest).rejects.toEqual(superseded());
    expect(modules.retirement.isBrowserPageRetired()).toBe(false);
    const signedIn = await sendGraphql();
    await expect(signedIn.json()).resolves.toEqual({ data: { viewer: `Bearer ${tokenFor(USER_A)}` } });
  });

  it('delivers an answer across a same-account credential rotation: the login did not change', async () => {
    await openPage();
    site.hold = true;
    const heldRequest = sendGraphql();
    await vi.waitFor(() => expect(site.held).toHaveLength(1));

    await modules.store.clearTokens();
    await modules.store.synchronizeWebSession();
    site.held.shift()?.();

    const response = await heldRequest;
    await expect(response.json()).resolves.toEqual({ data: { viewer: `Bearer ${tokenFor(USER_A)}` } });
    expect(modules.retirement.isBrowserPageRetired()).toBe(false);
  });

  it('refuses a send whose own session read retires the page, before it reaches the network', async () => {
    await openPage();
    // A signed-in session without its login id: the page keeps its latch on A
    // but no longer knows who the cookie belongs to, and holds no token.
    site.sessionBody = { user: { id: USER_A.userId } };
    await modules.store.synchronizeWebSession();
    site.sessionBody = null;
    site.cookie = USER_B;

    // The send's token read confirms B, which retires the page without a new
    // credential generation. B's token must still never leave this page.
    await expect(sendGraphql()).rejects.toEqual(superseded());

    expect(modules.retirement.isBrowserPageRetired()).toBe(true);
    expect(site.graphqlAuthorizations).toEqual([]);
  });

  it('returns the 401 and keeps the session when the session read is down', async () => {
    await openPage();
    site.graphqlStatus = [401];
    site.sessionStatus = 503;

    const response = await sendGraphql();

    expect(response.status).toBe(401);
    expect(modules.retirement.isBrowserPageRetired()).toBe(false);
    await expect(modules.store.getAuthToken()).resolves.toBe(tokenFor(USER_A));
  });
});

describe('Expo web GraphQL client', () => {
  it('does not count a superseded response as a backend failure', async () => {
    await openPage();
    const connectivity = await import('../connectivity/connectivity-store');
    const { getHttpClient } = await import('../graphql/client.web');
    site.hold = true;
    const heldQuery = getHttpClient().request('{ viewer }');
    await vi.waitFor(() => expect(site.held).toHaveLength(1));

    await switchCookieTo(USER_B);
    site.held.shift()?.();

    await expect(heldQuery).rejects.toEqual(superseded());
    expect(connectivity.getConnectivitySnapshot().consecutiveTransportFailures).toBe(0);
  });

  it('lets a mutation across a same-account rotation succeed, so its error toast never runs', async () => {
    await openPage();
    const { QueryClient, MutationObserver } = await import('@tanstack/react-query');
    const { getHttpClient } = await import('../graphql/client.web');
    const showErrorToast = vi.fn();
    const follow = new MutationObserver(new QueryClient(), {
      mutationFn: () => getHttpClient().request<{ viewer: string }>('mutation { viewer }'),
    });
    site.hold = true;
    const pending = follow.mutate(undefined, { onError: showErrorToast });
    await vi.waitFor(() => expect(site.held).toHaveLength(1));

    await modules.store.clearTokens();
    await modules.store.synchronizeWebSession();
    site.held.shift()?.();

    await expect(pending).resolves.toEqual({ viewer: `Bearer ${tokenFor(USER_A)}` });
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it('still counts a server failure (control for the assertion above)', async () => {
    await openPage();
    const connectivity = await import('../connectivity/connectivity-store');
    const { getHttpClient } = await import('../graphql/client.web');
    site.graphqlStatus = [500];

    await expect(getHttpClient().request('{ viewer }')).rejects.toBeDefined();
    expect(connectivity.getConnectivitySnapshot().consecutiveTransportFailures).toBe(1);
  });
});
