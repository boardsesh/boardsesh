// @vitest-environment node
/**
 * #7596 B1c with `AUTH_BROWSER_SESSION_MODE=better-auth`: guarded sign-out
 * through the real `/api/auth/[...nextauth]` route exports, against the real
 * backend handlers over HTTP and real PostgreSQL. Nothing scripts a backend
 * reply. The www cutover list is replaced through its test seam, never from
 * the environment.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { encode } from './legacy-credential-fixture';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { signBrowserSessionCookie } from '@boardsesh/auth-protocol/browser-session-cookie';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CookieJar, patchNextRequestIo, setCookieNames, setCookies } from './route-harness';
import {
  BRIDGED,
  COOKIE_SECRET,
  DOMAIN,
  LEGACY,
  LOGIN,
  SESSION_COOKIE_NAMES,
  browserSteps,
  canonicalStatus,
  createClimber,
  legacyStatus,
  loginToken,
  sessionCookieNamesIn,
  startWebSessionBackend,
  stubBetterAuthEnvironment,
  type WebSessionBackend,
} from './web-session-harness';

const holder = vi.hoisted(() => {
  // auth-options reads both when it loads: production www, shared Domain cookie.
  process.env.NEXTAUTH_SECRET = 'web-session-signout-proof-nextauth-secret-7596';
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

const secret = 'web-session-signout-proof-nextauth-secret-7596';
const { csrf, login, readSession, signOut } = browserSteps(authRoute);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: WebSessionBackend;
const statusOf = (token: string) => canonicalStatus(environment.database, token);

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

async function signedIn() {
  const climber = await createClimber(environment.database);
  const jar = new CookieJar();
  await login(jar, climber.email);
  const session = (await (await readSession(jar.header())).json()) as { authSessionId: string };
  return { jar, expected: { userId: climber.id, authSessionId: session.authSessionId } };
}

/** Every session cookie name cleared in both scopes. */
function expectEveryNameCleared(response: Response) {
  const cleared = setCookies(response).filter((header) => /^[^=]+=;/.test(header));
  for (const name of SESSION_COOKIE_NAMES) {
    expect(cleared.some((header) => header.startsWith(`${name}=;`) && !/Domain=/.test(header))).toBe(true);
    expect(cleared.some((header) => header.startsWith(`${name}=;`) && /Domain=\.boardsesh\.com/.test(header))).toBe(
      true,
    );
  }
}

describe('sign-out', () => {
  it('answers 409 and clears nothing when the cookie carries another login', async () => {
    const { jar, expected } = await signedIn();
    const response = await signOut(jar, { ...expected, authSessionId: randomUUID() });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'signout_identity_changed' });
    expect(setCookies(response)).toEqual([]);
    expect(await statusOf(loginToken(jar))).toBe('admitted');
  });

  it('ends the session and clears all four session cookie names', async () => {
    const { jar, expected } = await signedIn();
    const token = loginToken(jar);
    const response = await signOut(jar, expected);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://www.boardsesh.com/' });
    expectEveryNameCleared(response);
    expect(await statusOf(token)).not.toBe('admitted');
  });

  it('signs out a browser holding only the login cookie', async () => {
    const { jar, expected } = await signedIn();
    const token = loginToken(jar);
    const onlyLogin = new CookieJar();
    onlyLogin.set(LOGIN, jar.get(LOGIN, DOMAIN) ?? '', DOMAIN);
    const response = await signOut(onlyLogin, expected);
    expect(response.status).toBe(200);
    expect(setCookieNames(response)).toContain(LOGIN);
    expect(await statusOf(token)).not.toBe('admitted');
  });

  it('signs out a browser holding only a legacy cookie from before the switch', async () => {
    const climber = await createClimber(environment.database);
    const authSessionId = randomUUID();
    const legacy = await encode({ token: { sub: climber.id, authSessionId, gen: 0 }, secret, maxAge: 3600 });
    const jar = new CookieJar();
    jar.set(LEGACY, legacy, DOMAIN);
    const response = await signOut(jar, { userId: climber.id, authSessionId });
    expect(response.status).toBe(200);
    expectEveryNameCleared(response);
    expect(await legacyStatus(environment.database, legacy, secret)).toBe('denied');
  });

  it('clears a legacy cookie too long for any command, with nothing to end', async () => {
    const climber = await createClimber(environment.database);
    const padding = 'p'.repeat(13_000);
    const authSessionId = randomUUID();
    const legacy = await encode({ token: { sub: climber.id, authSessionId, padding }, secret, maxAge: 3600 });
    const jar = new CookieJar();
    jar.set(LEGACY, legacy, DOMAIN);
    const response = await signOut(jar, { userId: climber.id, authSessionId });
    expect(response.status).toBe(200);
    expectEveryNameCleared(response);
  });

  it('answers 409 and clears nothing for a conflicted login cookie', async () => {
    const { jar, expected } = await signedIn();
    const stray = signBrowserSessionCookie('login', randomBytes(32).toString('base64url'), COOKIE_SECRET);
    const response = await signOut(jar, expected, { cookie: `${LOGIN}=${stray}` });
    expect(response.status).toBe(409);
    expect(setCookies(response)).toEqual([]);
    expect(await statusOf(loginToken(jar))).toBe('admitted');
  });

  it("keeps NextAuth's CSRF refusal: nothing ends and nothing is cleared", async () => {
    const { jar, expected } = await signedIn();
    await csrf(jar);
    const response = await signOut(jar, expected, { csrfToken: 'not-the-csrf-token' });
    expect(sessionCookieNamesIn(response)).toEqual([]);
    expect(await statusOf(loginToken(jar))).toBe('admitted');
  });

  it('answers 503 and clears nothing when the backend is off', async () => {
    const { jar, expected } = await signedIn();
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'legacy');
    const response = await signOut(jar, expected);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'signout_authority_unavailable' });
    expect(setCookies(response)).toEqual([]);
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'backend-staging');
    expect(await statusOf(loginToken(jar))).toBe('admitted');
  });
});

describe('the bridged name', () => {
  it('is cleared on sign-out in both scopes too', async () => {
    const { jar, expected } = await signedIn();
    const response = await signOut(jar, expected);
    expect(setCookies(response)).toContain(
      `${BRIDGED}=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
    );
  });
});
