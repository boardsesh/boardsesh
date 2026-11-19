// @vitest-environment jsdom
/**
 * The viewer marker in the Expo web guard (#7596 decision, "how the guard
 * learns of an account switch on another host"): `admitSessionResponse` holds a
 * reply that lands under another login's marker for the shared session read.
 * A real local HTTP server plays www's session and ws-auth endpoints and the
 * backend's /graphql; `document.cookie` plays the marker www would write on
 * the parent domain. jsdom serves the page over http, so the plain name is read.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeViewerMarker, readViewerMarker, viewerMarkerCookieName } from '../viewer-marker.web';

vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '2.6.0' } } }));
vi.mock('../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));
// Vitest has no `.web` resolution; Metro gives client-default the web interceptor.
vi.mock('../auth-interceptor', () => import('../auth-interceptor.web'));

type Identity = { userId: string; authSessionId: string } | null;

/** The value vector the shared module and the server assert too (`viewer-marker.test.ts`). */
const VECTOR_SESSION_ID = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const VECTOR_MARKER = '4mo7SstrZQClO7Ck';

const USER_A = { userId: 'user-a', authSessionId: 'login-a' };
const USER_B = { userId: 'user-b', authSessionId: 'login-b' };
const MARKER = viewerMarkerCookieName(false);

const site = {
  cookie: USER_A as Identity,
  sessionStatus: 200,
  sessionReads: 0,
  hold: false,
  held: [] as (() => void)[],
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
    if (path === '/api/auth/session') {
      site.sessionReads += 1;
      if (site.sessionStatus !== 200) return send(site.sessionStatus, {});
      return send(
        200,
        site.cookie ? { user: { id: site.cookie.userId }, authSessionId: site.cookie.authSessionId } : {},
      );
    }
    if (path === '/api/internal/ws-auth') {
      if (!site.cookie) return send(200, { authenticated: false, token: null });
      return send(200, {
        authenticated: true,
        token: `jwe:${site.cookie.userId}:${site.cookie.authSessionId}`,
        ...site.cookie,
      });
    }
    if (path === '/graphql') {
      request.resume();
      const answer = () => send(200, { data: { viewer: request.headers.authorization ?? null } });
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

async function setBrowserMarker(value: string | undefined): Promise<void> {
  document.cookie = value === undefined ? `${MARKER}=; Max-Age=0; Path=/` : `${MARKER}=${value}; Path=/`;
}

/** A fresh page signed in as A, holding A's marker, with A's expected marker computed. */
async function openPageAsA({ withMarker = true } = {}): Promise<void> {
  vi.resetModules();
  vi.stubEnv('EXPO_PUBLIC_WEB_URL', origin);
  vi.stubEnv('EXPO_PUBLIC_BACKEND_URL', origin);
  site.cookie = USER_A;
  modules = {
    store: await import('../auth-store.web'),
    interceptor: await import('../auth-interceptor.web'),
    guard: await import('../browser-session-guard.web'),
    retirement: await import('../browser-page-retirement.web'),
  };
  await setBrowserMarker(withMarker ? await computeViewerMarker(USER_A.authSessionId) : undefined);
  await modules.store.synchronizeWebSession();
  await vi.waitFor(() => expect(modules.store.captureExpectedViewerMarker()).toBeDefined());
}

async function graphqlOutcome(): Promise<'delivered' | 'superseded'> {
  try {
    const response = await modules.interceptor.authenticatedFetch(`${origin}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ viewer }' }),
    });
    await response.json();
    return 'delivered';
  } catch (error) {
    if (modules.guard.isSessionSupersededError(error)) return 'superseded';
    throw error;
  }
}

beforeEach(() => {
  site.sessionStatus = 200;
  site.sessionReads = 0;
  site.hold = false;
  site.held = [];
});

afterEach(async () => {
  await setBrowserMarker(undefined);
});

describe('viewer marker codec on Expo web', () => {
  it('gives the shared value vector', async () => {
    expect(await computeViewerMarker(VECTOR_SESSION_ID)).toBe(VECTOR_MARKER);
  });

  it('reads the secure name on https and the plain one on http, and reports differing copies', () => {
    const cookie = `__Secure-boardsesh.viewer=${VECTOR_MARKER}; boardsesh.viewer=plain`;
    expect(readViewerMarker(cookie, true)).toEqual({ kind: 'present', value: VECTOR_MARKER });
    expect(readViewerMarker(cookie, false)).toEqual({ kind: 'present', value: 'plain' });
    expect(readViewerMarker('boardsesh.viewer=one; boardsesh.viewer=two', false)).toEqual({ kind: 'conflicted' });
    expect(readViewerMarker('', false)).toEqual({ kind: 'missing' });
  });
});

describe('admitSessionResponse and the viewer marker', () => {
  it('delivers a reply under the page’s own marker without a session read', async () => {
    await openPageAsA();
    const readsBefore = site.sessionReads;
    expect(await graphqlOutcome()).toBe('delivered');
    expect(site.sessionReads).toBe(readsBefore);
  });

  it('holds a reply landing under B’s marker; the session read names B, so it is superseded and the page retires', async () => {
    await openPageAsA();
    site.hold = true;
    const held = graphqlOutcome();
    await vi.waitFor(() => expect(site.held).toHaveLength(1));
    // B signs in on www: the shared cookie and the marker move; no message reaches this page.
    site.cookie = USER_B;
    await setBrowserMarker(await computeViewerMarker(USER_B.authSessionId));
    site.held.shift()?.();

    expect(await held).toBe('superseded');
    expect(modules.retirement.isBrowserPageRetired()).toBe(true);
  });

  it.each(['json', 'stream'])(
    'supersedes a delayed %s body after A’s headers arrive and B signs in',
    async (method) => {
      await openPageAsA();
      let finishBody!: () => void;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          finishBody = () => {
            controller.enqueue(new TextEncoder().encode('{"viewer":"user-a"}'));
            controller.close();
          };
        },
      });
      const response = await modules.guard.admitSessionResponse(
        new Response(stream),
        modules.guard.captureSessionStamp(),
      );
      const reading = method === 'json' ? response.json() : response.body!.getReader().read();
      site.cookie = USER_B;
      await setBrowserMarker(await computeViewerMarker(USER_B.authSessionId));
      finishBody();
      await expect(reading).rejects.toBeInstanceOf(modules.guard.SessionSupersededError);
      expect(modules.retirement.isBrowserPageRetired()).toBe(true);
    },
  );

  it('delivers a held reply when the session read confirms the same login, and checks that value once', async () => {
    await openPageAsA();
    await setBrowserMarker('tossed-from-a-sibling');
    const readsBefore = site.sessionReads;
    expect(await graphqlOutcome()).toBe('delivered');
    expect(await graphqlOutcome()).toBe('delivered');
    expect(site.sessionReads).toBe(readsBefore + 1);
    expect(modules.retirement.isBrowserPageRetired()).toBe(false);
  });

  it('supersedes the held reply when the session read proves nothing, then delivers later ones', async () => {
    await openPageAsA();
    await setBrowserMarker('false-during-outage');
    site.sessionStatus = 503;
    expect(await graphqlOutcome()).toBe('superseded');
    site.sessionStatus = 200;
    expect(await graphqlOutcome()).toBe('delivered');
    expect(modules.retirement.isBrowserPageRetired()).toBe(false);
  });

  it('treats a marker never seen as unknown', async () => {
    await openPageAsA({ withMarker: false });
    const readsBefore = site.sessionReads;
    expect(await graphqlOutcome()).toBe('delivered');
    expect(site.sessionReads).toBe(readsBefore);
  });

  it('treats its own marker gone after it was seen as a mismatch (a sign-out on www)', async () => {
    await openPageAsA();
    expect(await graphqlOutcome()).toBe('delivered');
    site.hold = true;
    const held = graphqlOutcome();
    await vi.waitFor(() => expect(site.held).toHaveLength(1));
    site.cookie = null;
    await setBrowserMarker(undefined);
    site.held.shift()?.();
    expect(await held).toBe('superseded');
    expect(modules.retirement.isBrowserPageRetired()).toBe(true);
  });

  it('with the mode off no marker is ever written: a planted one of any value is ignored, no session read', async () => {
    await openPageAsA({ withMarker: false });
    const readsBefore = site.sessionReads;
    for (const planted of [await computeViewerMarker(USER_B.authSessionId), 'tossed-from-a-sibling']) {
      await setBrowserMarker(planted);
      expect(await graphqlOutcome()).toBe('delivered');
    }
    expect(site.sessionReads).toBe(readsBefore);
  });

  it('treats two differing copies as one false value once armed: one session read, then delivered', async () => {
    await openPageAsA();
    const own = await computeViewerMarker(USER_A.authSessionId);
    // A copy at another Path or in another scope survives every clear, which reach Path=/ only.
    const cookie = vi.spyOn(document, 'cookie', 'get').mockReturnValue(`${MARKER}=${own}; ${MARKER}=tossed-copy`);
    try {
      const readsBefore = site.sessionReads;
      expect(await graphqlOutcome()).toBe('delivered');
      expect(await graphqlOutcome()).toBe('delivered');
      expect(site.sessionReads).toBe(readsBefore + 1);
    } finally {
      cookie.mockRestore();
    }
  });

  it('tries a session read that proved nothing again on a later reply, after a backoff', async () => {
    await openPageAsA();
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      await setBrowserMarker(await computeViewerMarker(USER_B.authSessionId));
      site.sessionStatus = 503;
      expect(await graphqlOutcome()).toBe('superseded');
      const readsAfterOutage = site.sessionReads;
      // Inside the backoff: delivered as before the marker, no second read.
      clock.mockReturnValue(start + 29_000);
      expect(await graphqlOutcome()).toBe('delivered');
      expect(site.sessionReads).toBe(readsAfterOutage);
      // After it: a new read, which now names B; the reply is superseded and the page retires.
      site.sessionStatus = 200;
      site.cookie = USER_B;
      clock.mockReturnValue(start + 31_000);
      expect(await graphqlOutcome()).toBe('superseded');
      expect(site.sessionReads).toBeGreaterThan(readsAfterOutage);
      expect(modules.retirement.isBrowserPageRetired()).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('checks four false values at most; a fifth turns the check off for the document', async () => {
    await openPageAsA();
    const readsBefore = site.sessionReads;
    for (const value of ['false-one', 'false-two', 'false-three', 'false-four']) {
      await setBrowserMarker(value);
      expect(await graphqlOutcome()).toBe('delivered');
    }
    expect(site.sessionReads).toBe(readsBefore + 4);
    await setBrowserMarker('false-five');
    expect(await graphqlOutcome()).toBe('delivered');
    expect(site.sessionReads).toBe(readsBefore + 4);
  });
});
