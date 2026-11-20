// @vitest-environment node
/**
 * #7596 B1c with `AUTH_BROWSER_SESSION_MODE=better-auth`: login and the session
 * read through the real `/api/auth/[...nextauth]` route exports, against the
 * real backend handlers over HTTP and real PostgreSQL. Nothing scripts a
 * backend reply: an outage is the real handler switched off, and the
 * transport's 401 is the real handler refusing a request with an `Origin`.
 * The www cutover list is replaced through its test seam, never from the env.
 */
import { mintDeviceToken, verifyDeviceToken } from '@boardsesh/auth-protocol/device-token';
import { __setPasswordGuessLimiterForTests } from '../../backend/src/auth/password-guess-limit';
import { randomBytes, randomUUID } from 'node:crypto';
import { decode, encode } from './legacy-credential-fixture';
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
  canonicalStatus,
  createClimber,
  expectViewerMarkerFor,
  legacyStatus,
  loginToken,
  sessionCookieNamesIn,
  startWebSessionBackend,
  stubBetterAuthEnvironment,
  type WebSessionBackend,
} from './web-session-harness';

const holder = vi.hoisted(() => {
  // auth-options reads both when it loads: production www, shared Domain cookie.
  process.env.NEXTAUTH_SECRET = 'web-session-cookie-proof-nextauth-secret-7596';
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
import { issueNativeOAuthTransferToken } from '../app/lib/auth/native-oauth-transfer';

const secret = 'web-session-cookie-proof-nextauth-secret-7596';
const { csrf, login, readSession } = browserSteps(authRoute);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: WebSessionBackend;
const climber = (options?: { verified?: boolean }) => createClimber(environment.database, options);
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
  __setPasswordGuessLimiterForTests(undefined);
  vi.unstubAllEnvs();
  vi.mocked(console.warn).mockRestore();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await backend?.close();
  await environment?.close();
});

type SessionJson = { user?: { id: string }; authSessionId?: string };
const sessionOf = async (cookie: string) => (await (await readSession(cookie)).json()) as SessionJson;

describe('login', () => {
  it('carries recognition and canonical issuance together and recognizes only a fully published login', async () => {
    const deviceSecret = 'combined-canonical-device-token-secret-32bytes';
    vi.stubEnv('AUTH_DEVICE_TOKEN_SECRET', deviceSecret);
    const climberA = await climber();
    const { token } = await mintDeviceToken({ userId: climberA.id, secret: deviceSecret });
    const admit = vi.fn(async () => ({ outcome: 'proceed' as const, settle: async () => {} }));
    __setPasswordGuessLimiterForTests({
      mode: 'observe',
      admit,
      settleCounted: async () => {},
      clearEmail: async () => {},
    });
    const jar = new CookieJar();
    const response = await login(jar, climberA.email, undefined, `__Host-boardsesh.device=${token}`);
    expect(response.status).toBe(200);
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ email: climberA.email, deviceToken: token }));
    expect(await statusOf(loginToken(jar))).toBe('admitted');
    const recognition = setCookies(response).find((cookie) => cookie.startsWith('__Host-boardsesh.device='));
    expect(
      await verifyDeviceToken(recognition?.split(';')[0].split('=')[1], { userId: climberA.id, secret: deviceSecret }),
    ).not.toBeNull();
    expect(sessionCookieNamesIn(response)).toContain(LEGACY);
    const session = await sessionOf(jar.header());
    expectViewerMarkerFor(response, session.authSessionId ?? '');
  });

  it('preserves a daily counter refusal as a 429 without publishing any login or recognition cookie', async () => {
    vi.stubEnv('AUTH_DEVICE_TOKEN_SECRET', 'combined-refused-device-token-secret-32bytes');
    const climberA = await climber();
    __setPasswordGuessLimiterForTests({
      mode: 'enforce',
      admit: async () => ({ outcome: 'refused', retryAfterSeconds: 86_400 }),
      settleCounted: async () => {},
      clearEmail: async () => {},
    });
    const response = await login(new CookieJar(), climberA.email);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('86400');
    expect(sessionCookieNamesIn(response)).toEqual([]);
    expect(setCookies(response).some((cookie) => cookie.startsWith('__Host-boardsesh.device='))).toBe(false);
  });

  it('does not publish recognition for a wrong password under the canonical mode', async () => {
    vi.stubEnv('AUTH_DEVICE_TOKEN_SECRET', 'combined-wrong-device-token-secret-32bytes');
    const climberA = await climber();
    const response = await login(new CookieJar(), climberA.email, 'wrong-password');
    expect(sessionCookieNamesIn(response)).toEqual([]);
    expect(setCookies(response).some((cookie) => cookie.startsWith('__Host-boardsesh.device='))).toBe(false);
  });

  it('writes the login cookie, clears the bridged name and the host-only login copy, and keeps the legacy cookie on the same session', async () => {
    const climberA = await climber();
    const jar = new CookieJar();
    const response = await login(jar, climberA.email);
    expect(response.status).toBe(200);
    const written = setCookies(response);
    expect(written.filter((header) => header.startsWith(`${LOGIN}=`))).toEqual([
      `${LOGIN}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
      expect.stringMatching(
        new RegExp(
          `^${LOGIN}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}; Path=/; Domain=\\.boardsesh\\.com; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure$`,
        ),
      ),
    ]);
    expect(written.filter((header) => header.startsWith(`${BRIDGED}=`))).toEqual([
      `${BRIDGED}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
      `${BRIDGED}=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
    ]);
    const session = await sessionOf(jar.header());
    expect(session.user?.id).toBe(climberA.id);
    // The viewer marker names the issued login, written last; its host-only copy is cleared first.
    expectViewerMarkerFor(response, session.authSessionId ?? '');
    expect(written).toContain(`${MARKER}=; Path=/; Max-Age=0; SameSite=Lax; Secure`);
    const legacy = await decode({ token: jar.get(LEGACY, DOMAIN) ?? '', secret });
    expect(legacy?.authSessionId).toBe(session.authSessionId);
    expect(await statusOf(loginToken(jar))).toBe('admitted');
  });

  it("as B while holding A's cookies revokes A's session and sets B's cookie", async () => {
    const [climberA, climberB] = [await climber(), await climber()];
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const tokenA = loginToken(jar);
    const legacyA = jar.get(LEGACY, DOMAIN) ?? '';
    await login(jar, climberB.email);
    expect((await sessionOf(jar.header())).user?.id).toBe(climberB.id);
    expect(await statusOf(tokenA)).not.toBe('admitted');
    expect(await legacyStatus(environment.database, legacyA, secret)).not.toBe('admitted');
  });

  it("with a conflicted login cookie presents the request's legacy cookie, so A's session ends", async () => {
    const [climberA, climberB] = [await climber(), await climber()];
    const jarA = new CookieJar();
    await login(jarA, climberA.email);
    const tokenA = loginToken(jarA);
    const legacyA = jarA.get(LEGACY, DOMAIN) ?? '';
    const stray = signBrowserSessionCookie('login', randomBytes(32).toString('base64url'), COOKIE_SECRET);
    const conflicted = `${LOGIN}=${jarA.get(LOGIN, DOMAIN)}; ${LOGIN}=${stray}; ${LEGACY}=${legacyA}`;
    const response = await login(new CookieJar(), climberB.email, undefined, conflicted);
    expect(response.status).toBe(200);
    expect(await legacyStatus(environment.database, legacyA, secret)).not.toBe('admitted');
    expect(await statusOf(tokenA)).not.toBe('admitted');
  });

  it('with a wrong password changes nothing and writes no session cookie', async () => {
    const climberA = await climber();
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const before = jar.header();
    const response = await login(jar, climberA.email, 'not the password');
    expect(response.status).toBe(401);
    expect(sessionCookieNamesIn(response)).toEqual([]);
    expect(await statusOf(loginToken(jar))).toBe('admitted');
    expect(jar.header()).toBe(before);
  });

  it('awaiting email verification goes to the verification page and writes no session cookie', async () => {
    vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'true');
    const unverified = await climber({ verified: false });
    const response = await login(new CookieJar(), unverified.email);
    expect(sessionCookieNamesIn(response)).toEqual([]);
    expect(((await response.json()) as { url: string }).url).toContain('/auth/verify-request?error=EmailNotVerified');
  });

  it('drops an oversized legacy cookie before the command and still signs in', async () => {
    const climberA = await climber();
    const jar = new CookieJar();
    jar.set(LEGACY, 'x'.repeat(12_289), DOMAIN);
    const response = await login(jar, climberA.email);
    expect(response.status).toBe(200);
    expect((await sessionOf(jar.header())).user?.id).toBe(climberA.id);
  });

  it('answers 503 and writes nothing when the backend is off', async () => {
    const climberA = await climber();
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'legacy');
    const response = await login(new CookieJar(), climberA.email);
    expect(response.status).toBe(503);
    expect(setCookies(response)).toEqual([]);
  });

  it('refuses the native transfer provider (#7596 B4c-web): no session cookie changes and the login stays', async () => {
    const [climberA, climberB] = [await climber(), await climber()];
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const before = jar.header();
    const transferToken = issueNativeOAuthTransferToken({
      userId: climberB.id,
      nextPath: '/',
      credentialProof: {
        version: 1,
        userId: climberB.id,
        authSessionId: randomUUID(),
        generation: 0,
        authenticatedAt: null,
        linkGuarded: false,
      },
    });
    const csrfToken = await csrf(jar);
    const response = await callRoute(authRoute, '/api/auth/callback/native-oauth', {
      cookie: jar.header(),
      form: { csrfToken, transferToken, json: 'true', callbackUrl: 'https://www.boardsesh.com/' },
    });
    expect(response.status).toBe(401);
    expect(sessionCookieNamesIn(response)).toEqual([]);
    jar.apply(response);
    expect(jar.header()).toBe(before);
    expect((await sessionOf(jar.header())).user?.id).toBe(climberA.id);
  });
});

describe('every response that sets the login cookie (review M3 invariant)', () => {
  /**
   * Sets a legacy cookie naming the same session, or clears the legacy names.
   * Rule (c) relies on it: a legacy cookie with another session id beside a
   * login cookie is then always the later sign-in.
   */
  async function expectLegacyTwinOrClear(response: Response) {
    const written = setCookies(response);
    const loginValue = written
      .filter((header) => header.startsWith(`${LOGIN}=`) && !header.startsWith(`${LOGIN}=;`))
      .map((header) => header.split(';', 1)[0].slice(LOGIN.length + 1))[0];
    if (loginValue === undefined) return;
    const admitted = await readFirstPartySession(environment.database, {
      kind: 'canonical-token',
      token: loginValue.slice(0, loginValue.indexOf('.')),
    });
    if (admitted.status !== 'admitted') throw new Error('The login cookie names no live session');
    const legacyValue = written
      .filter((header) => header.startsWith(`${LEGACY}=`) && !header.startsWith(`${LEGACY}=;`))
      .map((header) => header.split(';', 1)[0].slice(LEGACY.length + 1))[0];
    if (legacyValue === undefined) {
      expect(written.some((header) => header.startsWith(`${LEGACY}=;`))).toBe(true);
      return;
    }
    expect((await decode({ token: legacyValue, secret }))?.authSessionId).toBe(admitted.session.authSessionId);
  }

  it('holds for a fresh login, a login over another account, a conflicted cookie and an oversized legacy cookie', async () => {
    const [climberA, climberB] = [await climber(), await climber()];
    const jar = new CookieJar();
    await expectLegacyTwinOrClear(await login(jar, climberA.email));
    await expectLegacyTwinOrClear(await login(jar, climberB.email));
    const stray = signBrowserSessionCookie('login', randomBytes(32).toString('base64url'), COOKIE_SECRET);
    await expectLegacyTwinOrClear(
      await login(new CookieJar(), climberA.email, undefined, `${LOGIN}=${stray}; ${jar.header()}`),
    );
    const oversized = new CookieJar();
    oversized.set(LEGACY, 'x'.repeat(12_289), DOMAIN);
    await expectLegacyTwinOrClear(await login(oversized, climberB.email));
  });
});

describe('session read', () => {
  it('answers the NextAuth JSON shape from the backend, with no session Set-Cookie on GET, POST or csrf', async () => {
    const climberA = await climber();
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const viaGet = await readSession(jar.header());
    expect(viaGet.status).toBe(200);
    expect(viaGet.headers.get('cache-control')).toBe('private, no-store');
    const body = (await viaGet.json()) as Record<string, unknown>;
    expect(body).toEqual({
      user: { name: 'Climber', email: climberA.email, image: null, id: climberA.id },
      expires: expect.any(String),
      authGeneration: 0,
      authSessionId: expect.any(String),
    });
    const csrfToken = await csrf(jar);
    const viaPost = await readSession(jar.header(), 'POST', csrfToken);
    expect(await viaPost.json()).toEqual(body);
  });

  it('answers a legacy-only cookie on POST from the legacy path, without rewriting or bridging it', async () => {
    const climberA = await climber();
    const authSessionId = randomUUID();
    const legacy = await encode({ token: { sub: climberA.id, authSessionId, gen: 0 }, secret, maxAge: 3600 });
    const jar = new CookieJar();
    jar.set(LEGACY, legacy, DOMAIN);
    const csrfToken = await csrf(jar);
    const response = await readSession(jar.header(), 'POST', csrfToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: climberA.id }, authSessionId });
  });

  it('reads a valid legacy cookie too long for any command as signed out', async () => {
    const climberA = await climber();
    const padding = 'p'.repeat(13_000);
    const legacy = await encode({
      token: { sub: climberA.id, authSessionId: randomUUID(), padding },
      secret,
      maxAge: 3600,
    });
    const response = await readSession(`${LEGACY}=${legacy}`);
    expect(await response.json()).toEqual({});
  });

  it('reads a dead first-party session as signed out, with the denied header and no fall back to the legacy cookie', async () => {
    const climberA = await climber();
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const held = jar.header();
    await login(jar, climberA.email);
    const response = await readSession(held);
    expect(await response.json()).toEqual({});
    expect(response.headers.get('x-boardsesh-credential-authority')).toBe('denied');
  });

  it('reads a conflicted login cookie as signed out, never falling back to the bridged or legacy cookie', async () => {
    const climberA = await climber();
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const token = loginToken(jar);
    const cookie = [
      `${LOGIN}=${jar.get(LOGIN, DOMAIN)}`,
      `${LOGIN}=${signBrowserSessionCookie('login', randomBytes(32).toString('base64url'), COOKIE_SECRET)}`,
      `${BRIDGED}=${signBrowserSessionCookie('bridged', token, COOKIE_SECRET)}`,
      `${LEGACY}=${jar.get(LEGACY, DOMAIN)}`,
    ].join('; ');
    const response = await readSession(cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  it('answers 503 with no Set-Cookie when the backend is off or refuses the channel', async () => {
    const climberA = await climber();
    const jar = new CookieJar();
    await login(jar, climberA.email);
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'legacy');
    expect((await readSession(jar.header())).status).toBe(503);
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', backend.refusingOrigin);
    expect((await readSession(jar.header())).status).toBe(503);
  });
});

describe('the www cutover list', () => {
  it('keeps every auth route at 503 while work is listed; production code lists none since #7880', async () => {
    const { browserSessionRouteModeResolver, BROWSER_SESSION_WEB_CUTOVER_BLOCKERS } = await vi.importActual<
      typeof import('../app/lib/auth/browser-session-mode.server')
    >('../app/lib/auth/browser-session-mode.server');
    expect(browserSessionRouteModeResolver(['B9_EXAMPLE_WORK'])()).toMatchObject({
      kind: 'unavailable',
      code: 'AUTH_BROWSER_SESSION_WEB_CUTOVER_INCOMPLETE',
    });
    expect(BROWSER_SESSION_WEB_CUTOVER_BLOCKERS).toEqual([]);
  });
});
