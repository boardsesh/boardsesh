// @vitest-environment node
/**
 * #7596 B2b, rule (c) and review H1 and M1: a stale first-party cookie (login
 * or bridged) beside a newer legacy login made during a rollback. The real
 * route exports, the real backend `/bridge`, `/session` and password handlers
 * over HTTP, real PostgreSQL; nothing scripts a backend reply. The www cutover
 * list is replaced through its test seam, never from the environment.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { encode, type JWT } from './legacy-credential-fixture';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { authSession } from '@boardsesh/db/schema';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CookieJar, patchNextRequestIo, setCookies } from './route-harness';
import {
  BRIDGED,
  DOMAIN,
  LEGACY,
  LOGIN,
  MARKER,
  browserSteps,
  createClimber,
  expectViewerMarkerFor,
  startWebSessionBackend,
  stubBetterAuthEnvironment,
  type WebSessionBackend,
} from './web-session-harness';

const holder = vi.hoisted(() => {
  // auth-options reads both when it loads: production www, shared Domain cookie.
  process.env.NEXTAUTH_SECRET = 'web-session-replace-proof-nextauth-secret-7596';
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

const secret = 'web-session-replace-proof-nextauth-secret-7596';
const { login, readSession } = browserSteps(authRoute);
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

const writingRead = (cookie: string) => readSession(cookie, 'GET', '', { writes: true });
const bridgedCookieOf = (response: Response) =>
  setCookies(response).find((header) => header.startsWith(`${BRIDGED}=`) && !header.startsWith(`${BRIDGED}=;`));
const clearsOf = (response: Response, name: string) =>
  setCookies(response).filter((header) => header.startsWith(`${name}=;`));
const SECONDS = (offsetMs: number) => Math.floor((Date.now() + offsetMs) / 1000);

/** A password login whose session row says it signed in at `authenticatedAt`. */
async function loggedIn(authenticatedAt: Date | null) {
  const climber = await createClimber(environment.database);
  const jar = new CookieJar();
  await login(jar, climber.email);
  const { authSessionId } = (await (await readSession(jar.header())).json()) as { authSessionId: string };
  await environment.database
    .update(authSession)
    .set({ originalAuthenticatedAt: authenticatedAt })
    .where(eq(authSession.id, authSessionId));
  return { climber, loginCookie: `${LOGIN}=${jar.get(LOGIN, DOMAIN)}`, twin: jar.get(LEGACY, DOMAIN) ?? '' };
}

/** A bridged cookie for a legacy login from before the switch. */
async function bridgedBrowser() {
  const legacy = await legacyLogin();
  const read = await readSession(`${LEGACY}=${legacy.credential}`, 'GET', '', { bridges: true });
  const bridged = bridgedCookieOf(read)?.split(';', 1)[0];
  if (!bridged) throw new Error('No bridged cookie');
  return { ...legacy, bridgedCookie: bridged };
}

const hourAgo = () => new Date(Date.now() - 3_600_000);

describe('beside a login cookie', () => {
  it.each([
    ['its auth_time', {}],
    ['its issue time when it has no auth_time', { auth_time: undefined }],
  ])(
    'a legacy login newer by %s replaces it: bridged, the login cookie cleared in both scopes',
    async (_by, claims) => {
      const { loginCookie } = await loggedIn(hourAgo());
      const { climber, authSessionId, credential } = await legacyLogin(claims);
      const response = await writingRead(`${loginCookie}; ${LEGACY}=${credential}`);
      expect(await response.json()).toMatchObject({ user: { id: climber.id }, authSessionId });
      expect(clearsOf(response, LOGIN)).toEqual([
        `${LOGIN}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
        `${LOGIN}=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
      ]);
      expect(bridgedCookieOf(response)).toBeDefined();
      // The marker moves to the bridged login with it.
      expectViewerMarkerFor(response, authSessionId);
    },
  );

  it.each([
    ['an older auth_time', hourAgo(), { auth_time: SECONDS(-7_200_000) }],
    ['an older issue time', new Date(Date.now() + 3_600_000), { auth_time: undefined }],
    ['an unknown authenticatedAt', null, {}],
  ])(
    'keeps the login cookie against a legacy login with %s, writing nothing',
    async (_case, authenticatedAt, claims) => {
      const { climber, loginCookie } = await loggedIn(authenticatedAt);
      const { credential } = await legacyLogin(claims);
      const response = await readSession(`${loginCookie}; ${LEGACY}=${credential}`);
      expect(await response.json()).toMatchObject({ user: { id: climber.id } });
      expect(setCookies(response)).toEqual([]);
    },
  );

  it('keeps the login cookie against its own legacy twin rewritten later (same session id)', async () => {
    const { climber, loginCookie, twin } = await loggedIn(hourAgo());
    const response = await readSession(`${loginCookie}; ${LEGACY}=${twin}`);
    expect(await response.json()).toMatchObject({ user: { id: climber.id } });
    expect(setCookies(response)).toEqual([]);
  });

  it('signs out, clearing every name, when the newer legacy login is denied (never back to the stale login)', async () => {
    const { loginCookie } = await loggedIn(hourAgo());
    // A stamp the account never had: the backend denies the bridge.
    const { credential } = await legacyLogin({ gen: 5 });
    const response = await writingRead(`${loginCookie}; ${LEGACY}=${credential}`);
    expect(await response.json()).toEqual({});
    for (const name of [LOGIN, BRIDGED, LEGACY]) {
      expect(clearsOf(response, name)).toContain(`${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
      expect(clearsOf(response, name)).toContain(
        `${name}=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
      );
    }
    expect(bridgedCookieOf(response)).toBeUndefined();
    // The session read's first-party-and-legacy clears take the marker too, and write none.
    expect(clearsOf(response, MARKER)).toEqual([
      `${MARKER}=; Path=/; Max-Age=0; SameSite=Lax; Secure`,
      `${MARKER}=; Path=/; Domain=.boardsesh.com; Max-Age=0; SameSite=Lax; Secure`,
    ]);
    expect(setCookies(response).filter((header) => header.startsWith(`${MARKER}=`))).toHaveLength(2);
  });
});

describe('beside a bridged cookie (review H1)', () => {
  it.each([
    ['a newer', {}],
    ['an older', { auth_time: SECONDS(-7_200_000) }],
  ])('%s legacy login with another session id replaces it, with no time test', async (_order, claims) => {
    const { bridgedCookie } = await bridgedBrowser();
    const { climber, authSessionId, credential } = await legacyLogin(claims);
    const response = await writingRead(`${bridgedCookie}; ${LEGACY}=${credential}`);
    expect(await response.json()).toMatchObject({ user: { id: climber.id }, authSessionId });
    const replacement = bridgedCookieOf(response);
    expect(replacement?.split(';', 1)[0]).not.toBe(bridgedCookie);
    expect(clearsOf(response, LOGIN)).toEqual([]);
  });

  it('keeps the bridged cookie against the legacy cookie it was bridged from, writing nothing', async () => {
    const { climber, authSessionId, credential, bridgedCookie } = await bridgedBrowser();
    const response = await readSession(`${bridgedCookie}; ${LEGACY}=${credential}`);
    expect(await response.json()).toMatchObject({ user: { id: climber.id }, authSessionId });
    expect(setCookies(response)).toEqual([]);
  });

  it('keeps the bridged cookie against a legacy cookie with no session id claim', async () => {
    const { climber, bridgedCookie } = await bridgedBrowser();
    const other = await createClimber(environment.database);
    const claimless = await encode({ token: { sub: other.id }, secret, maxAge: 3600 });
    const response = await readSession(`${bridgedCookie}; ${LEGACY}=${claimless}`);
    expect(await response.json()).toMatchObject({ user: { id: climber.id } });
    expect(setCookies(response)).toEqual([]);
  });
});
