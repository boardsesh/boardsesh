// @vitest-environment node
/**
 * #7596 B2b with `AUTH_BROWSER_SESSION_MODE=better-auth`: `/api/auth/session`
 * bridges a browser signed in before the switch, through the real route
 * exports and the real backend `/bridge`, `/session` and password handlers
 * over HTTP and real PostgreSQL. Nothing scripts a backend reply. The www
 * cutover list is replaced through its test seam, never from the environment.
 */
import { randomUUID } from 'node:crypto';
import { encode, type JWT } from './legacy-credential-fixture';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { signBrowserSessionCookie } from '@boardsesh/auth-protocol/browser-session-cookie';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CookieJar, callRoute, patchNextRequestIo, setCookies } from './route-harness';
import {
  BRIDGED,
  COOKIE_SECRET,
  DOMAIN,
  LEGACY,
  LOGIN,
  MARKER,
  browserSteps,
  createClimber,
  expectViewerMarkerFor,
  randomClientAddress,
  sessionCookieNamesIn,
  startWebSessionBackend,
  stubBetterAuthEnvironment,
  type WebSessionBackend,
} from './web-session-harness';

const holder = vi.hoisted(() => {
  // auth-options reads both when it loads: production www, shared Domain cookie.
  process.env.NEXTAUTH_SECRET = 'web-session-bridge-proof-nextauth-secret-7596';
  process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
  return { database: undefined as unknown };
});
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({ getDb: () => holder.database }));
vi.mock('../../backend/src/db/client', () => ({
  get db() {
    return holder.database;
  },
}));
vi.mock('../../backend/src/auth/admission-pool', () => ({
  readOnAdmissionConnection: async (mark: () => void, read: (database: unknown) => PromiseLike<unknown>) => {
    mark();
    return read(holder.database);
  },
}));
// The legacy cookie's GraphQL admission, answered by the backend's own reader.
vi.mock('../app/lib/auth/credential-admission.server', async (original) => ({
  ...(await original<typeof import('../app/lib/auth/credential-admission.server')>()),
  admitPresentedWebCredential: async (credential: string) => {
    const result = await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential, secret });
    if (result.status === 'unavailable') throw new Error('Owned authority unavailable');
    return result.status === 'admitted' ? result.session.userId : null;
  },
}));
// The test seam: the preconditions alone, as once the www cutover list is empty.
vi.mock('../app/lib/auth/browser-session-mode.server', async (original) => {
  const actual = await original<typeof import('../app/lib/auth/browser-session-mode.server')>();
  return { ...actual, browserSessionRouteMode: actual.browserSessionRouteModeResolver([]) };
});

import * as authRoute from '../app/api/auth/[...nextauth]/route';
import { BRIDGES_PER_CLIENT } from '../app/lib/auth/browser-session-bridge.server';

const secret = 'web-session-bridge-proof-nextauth-secret-7596';
const { csrf, login, readSession } = browserSteps(authRoute);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: WebSessionBackend;

beforeAll(async () => {
  environment = await createEnvironment();
  holder.database = environment.database;
  backend = await startWebSessionBackend(environment.database);
  patchNextRequestIo();
});
beforeEach(() => {
  stubBetterAuthEnvironment(backend.origin);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(console.warn).mockRestore();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await backend?.close();
  await environment?.close();
});

type SessionJson = { user?: { id: string }; authSessionId?: string };

/** A NextAuth cookie from before the switch: a login with its own session id. */
async function legacyLogin(claims: Partial<JWT> = {}) {
  const climber = await createClimber(environment.database);
  const authSessionId = randomUUID();
  const credential = await encode({
    token: { sub: climber.id, authSessionId, gen: 0, auth_time: Math.floor(Date.now() / 1000), ...claims },
    secret,
    maxAge: 3600,
  });
  return { climber, authSessionId, credential };
}

/** A bridging read: the bridged cookie is the one session cookie it may write. */
const bridgingRead = (cookie: string, clientAddress?: string) =>
  readSession(cookie, 'GET', '', { bridges: true, ...(clientAddress ? { clientAddress } : {}) });

function bridgedCookieOf(response: Response): string | undefined {
  return setCookies(response).find((header) => header.startsWith(`${BRIDGED}=`) && !header.startsWith(`${BRIDGED}=;`));
}

describe('a browser signed in before the switch', () => {
  it.each([
    // Host-only and Domain copies send the same header; the server cannot tell them apart.
    ['the cookie this deployment writes', (credential: string) => `${LEGACY}=${credential}`],
    [
      'a chunked cookie',
      (credential: string) => `${LEGACY}.0=${credential.slice(0, 700)}; ${LEGACY}.1=${credential.slice(700)}`,
    ],
  ])(
    'is bridged from %s, keeps its session id and its legacy cookie, and the next read writes nothing',
    async (_shape, cookieOf) => {
      const { climber, authSessionId, credential } = await legacyLogin();
      const first = await bridgingRead(cookieOf(credential));
      expect(first.status).toBe(200);
      expect(first.headers.get('cache-control')).toBe('private, no-store');
      expect(await first.json()).toMatchObject({ user: { id: climber.id }, authSessionId });
      const bridged = bridgedCookieOf(first);
      expect(bridged).toMatch(/; Domain=\.boardsesh\.com; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure$/);
      // A host-only marker copy is cleared first (review of #7810, L6), then the bridged cookie and its marker.
      expect(sessionCookieNamesIn(first)).toEqual([MARKER, BRIDGED, MARKER]);
      expect(setCookies(first)[0]).toBe(`${MARKER}=; Path=/; Max-Age=0; SameSite=Lax; Secure`);
      expectViewerMarkerFor(first, authSessionId);
      const bridgedValue = bridged?.split(';', 1)[0] ?? '';
      const second = await readSession(`${bridgedValue}; ${cookieOf(credential)}`);
      expect(setCookies(second)).toEqual([]);
      expect(await second.json()).toMatchObject({ user: { id: climber.id }, authSessionId });
    },
  );

  it('with a host-only and a Domain legacy cookie of differing values reads as signed out and bridges nothing', async () => {
    const [first, second] = [await legacyLogin(), await legacyLogin()];
    const response = await readSession(`${LEGACY}=${first.credential}; ${LEGACY}=${second.credential}`);
    expect(await response.json()).toEqual({});
    expect(setCookies(response)).toEqual([]);
  });

  it.each([
    [
      'a base name beside chunk names',
      (one: string) => `${LEGACY}=${one}; ${LEGACY}.0=${one.slice(0, 700)}; ${LEGACY}.1=${one.slice(700)}`,
    ],
    [
      'the plain and the secure name with differing values',
      (one: string, other: string) => `${LEGACY}=${one}; next-auth.session-token=${other}`,
    ],
  ])('with %s reads as signed out and bridges nothing', async (_shape, cookieOf) => {
    const [first, second] = [await legacyLogin(), await legacyLogin()];
    const response = await readSession(cookieOf(first.credential, second.credential));
    expect(await response.json()).toEqual({});
    expect(setCookies(response)).toEqual([]);
  });

  it('never bridges a plain-named cookie in a secure context: signed out, as the legacy path reads only the secure name', async () => {
    const { credential } = await legacyLogin();
    const response = await readSession(`next-auth.session-token=${credential}`);
    expect(await response.json()).toEqual({});
    expect(sessionCookieNamesIn(response)).toEqual([]);
  });

  it('keeps the session id of a legacy_no_sid cookie, and gives a claimless cookie its derived id', async () => {
    const marked = await legacyLogin({ legacy_no_sid: true });
    const markedRead = await bridgingRead(`${LEGACY}=${marked.credential}`);
    expect(await markedRead.json()).toMatchObject({
      user: { id: marked.climber.id },
      authSessionId: marked.authSessionId,
    });
    const claimless = await createClimber(environment.database);
    const credential = await encode({ token: { sub: claimless.id }, secret, maxAge: 3600 });
    const claimlessRead = await bridgingRead(`${LEGACY}=${credential}`);
    const body = (await claimlessRead.json()) as SessionJson;
    expect(body.user?.id).toBe(claimless.id);
    expect(body.authSessionId).toMatch(/^credential:/);
    expect(bridgedCookieOf(claimlessRead)).toBeDefined();
  });

  it('whose cookie the backend denies (a rollback cookie of a login) reads as signed out and its chunks are cleared', async () => {
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    const rollbackCookie = jar.get(LEGACY, DOMAIN) ?? '';
    // Chunked, so the clears must reach every chunk name the request carried.
    const chunked = `${LEGACY}.0=${rollbackCookie.slice(0, 700)}; ${LEGACY}.1=${rollbackCookie.slice(700)}`;
    const response = await readSession(chunked, 'GET', '', { writes: true });
    expect(await response.json()).toEqual({});
    const cleared = setCookies(response);
    for (const name of [LEGACY, `${LEGACY}.0`, `${LEGACY}.1`]) {
      expect(cleared).toContain(`${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
      expect(cleared).toContain(`${name}=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
    }
    expect(bridgedCookieOf(response)).toBeUndefined();
  });

  it('reads as signed out, its cookie cleared, once the bridge has ended (AUTH_LEGACY_BRIDGE_UNTIL)', async () => {
    const { credential } = await legacyLogin();
    vi.stubEnv('AUTH_LEGACY_BRIDGE_UNTIL', new Date(Date.now() - 1000).toISOString());
    const response = await readSession(`${LEGACY}=${credential}`, 'GET', '', { writes: true });
    expect(await response.json()).toEqual({});
    expect(setCookies(response)).toContain(`${LEGACY}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
    expect(bridgedCookieOf(response)).toBeUndefined();
  });

  it('keeps the legacy answer and changes no cookie while the backend is off', async () => {
    const { climber, authSessionId, credential } = await legacyLogin();
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'legacy');
    const response = await readSession(`${LEGACY}=${credential}`);
    expect(await response.json()).toMatchObject({ user: { id: climber.id }, authSessionId });
    expect(sessionCookieNamesIn(response)).toEqual([]);
  });

  it('is never bridged by csrf or a POST session read', async () => {
    const { credential } = await legacyLogin();
    const jar = new CookieJar();
    jar.set(LEGACY, credential, DOMAIN);
    const csrfToken = await csrf(jar);
    const posted = await readSession(jar.header(), 'POST', csrfToken);
    expect(sessionCookieNamesIn(posted)).toEqual([]);
  });

  it('beside an unverifiable first-party cookie is bridged with no cookie written, and is not bridged beside a conflicted bridged name', async () => {
    const { climber, authSessionId, credential } = await legacyLogin();
    // #7792 review M4b: the bridged session's JSON, the legacy cookie's id, no Set-Cookie of any kind.
    const unverified = await readSession(`${LOGIN}=not-a-signed-value; ${LEGACY}=${credential}`);
    expect(await unverified.json()).toMatchObject({ user: { id: climber.id }, authSessionId });
    expect(setCookies(unverified)).toEqual([]);
    const strays = [randomUUID(), randomUUID()].map((token) =>
      signBrowserSessionCookie('bridged', token.replaceAll('-', ''), COOKIE_SECRET),
    );
    const conflicted = await readSession(`${BRIDGED}=${strays[0]}; ${BRIDGED}=${strays[1]}; ${LEGACY}=${credential}`);
    expect(await conflicted.json()).toEqual({});
    expect(setCookies(conflicted)).toEqual([]);
  });

  it('beside an unverifiable first-party cookie, a denied legacy cookie reads signed out with nothing cleared', async () => {
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    // A login's rollback twin on its own is denied by the bridge.
    const response = await readSession(`${LOGIN}=not-a-signed-value; ${LEGACY}=${jar.get(LEGACY, DOMAIN)}`);
    expect(await response.json()).toEqual({});
    expect(setCookies(response)).toEqual([]);
  });

  it('stops bridging one client over its limit and answers as the legacy path', async () => {
    const { climber, credential } = await legacyLogin();
    const clientAddress = randomClientAddress();
    for (let count = 0; count < BRIDGES_PER_CLIENT; count += 1)
      expect(bridgedCookieOf(await bridgingRead(`${LEGACY}=${credential}`, clientAddress))).toBeDefined();
    const limited = await readSession(`${LEGACY}=${credential}`, 'GET', '', { clientAddress });
    expect(await limited.json()).toMatchObject({ user: { id: climber.id } });
    expect(sessionCookieNamesIn(limited)).toEqual([]);
  });
});

describe('a bridge reply that arrives after a login as B', () => {
  it('leaves B signed in when the bridge of A ran first', async () => {
    const climberB = await createClimber(environment.database);
    const { credential } = await legacyLogin();
    const jar = new CookieJar();
    jar.set(LEGACY, credential, DOMAIN);
    const delayed = await bridgingRead(jar.header());
    expect(bridgedCookieOf(delayed)).toBeDefined();
    await login(jar, climberB.email);
    jar.apply(delayed);
    expect(((await (await readSession(jar.header())).json()) as SessionJson).user?.id).toBe(climberB.id);
  });

  it('leaves B signed in when the login revoked A before the bridge answered', async () => {
    const climberB = await createClimber(environment.database);
    const { credential } = await legacyLogin();
    const jar = new CookieJar();
    jar.set(LEGACY, credential, DOMAIN);
    const sentBeforeLogin = jar.header();
    await login(jar, climberB.email);
    const delayed = await readSession(sentBeforeLogin, 'GET', '', { writes: true });
    expect(await delayed.json()).toEqual({});
    jar.apply(delayed);
    expect(((await (await readSession(jar.header())).json()) as SessionJson).user?.id).toBe(climberB.id);
  });
});

describe('sign-out after a bridge', () => {
  it('ends the bridged session through its cookie and clears every name', async () => {
    const { climber, authSessionId, credential } = await legacyLogin();
    const jar = new CookieJar();
    jar.set(LEGACY, credential, DOMAIN);
    jar.apply(await bridgingRead(jar.header()));
    const token = (jar.get(BRIDGED, DOMAIN) ?? '').split('.')[0];
    const csrfToken = await csrf(jar);
    const response = await callRoute(authRoute, '/api/auth/signout', {
      cookie: jar.header(),
      form: {
        csrfToken,
        callbackUrl: 'https://www.boardsesh.com/',
        json: 'true',
        expectedUserId: climber.id,
        expectedAuthSessionId: authSessionId,
      },
    });
    expect(response.status).toBe(200);
    expect(sessionCookieNamesIn(response)).toEqual(expect.arrayContaining([LOGIN, BRIDGED, LEGACY, MARKER]));
    expect((await readFirstPartySession(environment.database, { kind: 'canonical-token', token })).status).not.toBe(
      'admitted',
    );
  });
});
