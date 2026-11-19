import './legacy-credential-fixture';
// @vitest-environment node
/**
 * With `AUTH_BROWSER_SESSION_MODE` unset, empty or `legacy`, the real
 * `/api/auth/[...nextauth]` route answers login, session and sign-out exactly
 * as it did before B1c (#7596): same status, body and `Set-Cookie` list. The
 * inline snapshots were written by this file run against the route before any
 * B1c change, and must not move.
 *
 * Real: the route exports, NextAuth, auth-options, bcrypt, PostgreSQL. The
 * credential admission is the backend's own reader over the same database,
 * as in `web-credential-proof.integration.proof.ts`.
 */
import { hash } from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { userCredentials, users } from '@boardsesh/db/schema';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CookieJar, callRoute, normalizedResponse, patchNextRequestIo } from './route-harness';

const holder = vi.hoisted(() => {
  // auth-options reads both when it loads: production www, shared Domain cookie.
  process.env.NEXTAUTH_SECRET = 'legacy-route-snapshot-nextauth-secret-7596';
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
vi.mock('../app/lib/auth/credential-admission.server', async (original) => ({
  ...(await original<typeof import('../app/lib/auth/credential-admission.server')>()),
  admitPresentedWebCredential: async (credential: string) => {
    const result = await readFirstPartySession(environment.database, {
      kind: 'legacy-jwe',
      credential,
      secret: process.env.NEXTAUTH_SECRET ?? '',
    });
    if (result.status === 'unavailable') throw new Error('Owned authority unavailable');
    return result.status === 'admitted' ? result.session.userId : null;
  },
}));

import * as authRoute from '../app/api/auth/[...nextauth]/route';

const CLIMBER = { id: '0b5f2c1e-7596-4b1c-8a11-000000000001', email: 'snapshot-climber@example.test' };
const PASSWORD = 'snapshot climber password';
let environment: Awaited<ReturnType<typeof createEnvironment>>;

beforeAll(async () => {
  environment = await createEnvironment();
  holder.database = environment.database;
  await environment.database.insert(users).values({ ...CLIMBER, name: 'Snapshot Climber', emailVerified: new Date() });
  await environment.database
    .insert(userCredentials)
    .values({ userId: CLIMBER.id, passwordHash: await hash(PASSWORD, 4) });
  patchNextRequestIo();
});
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(console.warn).mockRestore();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await environment?.close();
});

/** A first-party cookie a browser could hold after a rollback, added to every request when set. */
let carriedFirstParty = '';
const cookieOf = (jar: CookieJar) => [jar.header(), carriedFirstParty].filter(Boolean).join('; ');

async function csrf(jar: CookieJar): Promise<string> {
  const response = await callRoute(authRoute, '/api/auth/csrf', { cookie: cookieOf(jar) });
  jar.apply(response);
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return csrfToken;
}

async function login(jar: CookieJar, password: string) {
  const csrfToken = await csrf(jar);
  const response = await callRoute(authRoute, '/api/auth/callback/credentials', {
    cookie: cookieOf(jar),
    form: { csrfToken, email: CLIMBER.email, password, json: 'true', callbackUrl: 'https://www.boardsesh.com/' },
  });
  jar.apply(response);
  return response;
}

async function signOut(jar: CookieJar, expectedAuthSessionId: string) {
  const csrfToken = await csrf(jar);
  return callRoute(authRoute, '/api/auth/signout', {
    cookie: cookieOf(jar),
    form: {
      csrfToken,
      callbackUrl: 'https://www.boardsesh.com/',
      json: 'true',
      expectedUserId: CLIMBER.id,
      expectedAuthSessionId,
    },
  });
}

/** Every answer the snapshot covers, in one object so each mode compares against the same record. */
async function routeAnswers() {
  const right = new CookieJar();
  const loginRight = await normalizedResponse(await login(right, PASSWORD));
  const sessionSignedIn = await callRoute(authRoute, '/api/auth/session', { cookie: cookieOf(right) });
  const { authSessionId } = (await sessionSignedIn.clone().json()) as { authSessionId: string };
  const wrong = new CookieJar();
  return {
    loginRight,
    loginWrong: await normalizedResponse(await login(wrong, 'not the password')),
    sessionSignedIn: await normalizedResponse(sessionSignedIn),
    sessionAnonymous: await normalizedResponse(
      await callRoute(authRoute, '/api/auth/session', carriedFirstParty ? { cookie: carriedFirstParty } : {}),
    ),
    signOutOtherLogin: await normalizedResponse(await signOut(right, 'another-login')),
    signOutShownLogin: await normalizedResponse(await signOut(right, authSessionId)),
  };
}

describe('AUTH_BROWSER_SESSION_MODE off: the route answers as before B1c', () => {
  it('unset', async () => {
    expect(await routeAnswers()).toMatchInlineSnapshot(`
      {
        "loginRight": {
          "body": {
            "url": "https://www.boardsesh.com/",
          },
          "cacheControl": "private, no-store",
          "location": null,
          "setCookies": [
            "__Secure-next-auth.callback-url=<value>; Domain=.boardsesh.com; Path=/; HttpOnly; Secure; SameSite=None",
            "__Secure-next-auth.session-token=<value>; Domain=.boardsesh.com; Path=/; Expires=<date>; HttpOnly; Secure; SameSite=Lax",
            "__Secure-next-auth.session-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
          ],
          "status": 200,
        },
        "loginWrong": {
          "body": {
            "url": "https://www.boardsesh.com/api/auth/error?error=CredentialsSignin&provider=credentials",
          },
          "cacheControl": "private, no-store",
          "location": null,
          "setCookies": [
            "__Secure-next-auth.callback-url=<value>; Domain=.boardsesh.com; Path=/; HttpOnly; Secure; SameSite=None",
          ],
          "status": 401,
        },
        "sessionAnonymous": {
          "body": {},
          "cacheControl": "private, no-store",
          "location": null,
          "setCookies": [
            "__Host-next-auth.csrf-token=<value>; Path=/; HttpOnly; Secure; SameSite=Lax",
            "__Secure-next-auth.callback-url=<value>; Domain=.boardsesh.com; Path=/; HttpOnly; Secure; SameSite=None",
          ],
          "status": 200,
        },
        "sessionSignedIn": {
          "body": {
            "authGeneration": 0,
            "authSessionId": "<uuid>",
            "expires": "<date>",
            "user": {
              "email": "snapshot-climber@example.test",
              "id": "<uuid>",
              "image": null,
              "name": "Snapshot Climber",
            },
          },
          "cacheControl": "private, no-store",
          "location": null,
          "setCookies": [
            "__Secure-next-auth.session-token=<value>; Domain=.boardsesh.com; Path=/; Expires=<date>; HttpOnly; Secure; SameSite=Lax",
            "__Secure-next-auth.session-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
          ],
          "status": 200,
        },
        "signOutOtherLogin": {
          "body": {
            "error": "signout_identity_changed",
          },
          "cacheControl": "private, no-store",
          "location": null,
          "setCookies": [],
          "status": 409,
        },
        "signOutShownLogin": {
          "body": {
            "url": "https://www.boardsesh.com/",
          },
          "cacheControl": "private, no-store",
          "location": null,
          "setCookies": [
            "__Secure-next-auth.session-token=; Max-Age=0; Domain=.boardsesh.com; Path=/; HttpOnly; Secure; SameSite=Lax",
            "__Secure-next-auth.session-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
            "__Secure-next-auth.session-token=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
            "next-auth.session-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
            "next-auth.session-token=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
          ],
          "status": 200,
        },
      }
    `);
  });

  it.each(['', 'legacy'])('%j answers exactly as unset', async (mode) => {
    const unset = await routeAnswers();
    vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
    expect(await routeAnswers()).toEqual(unset);
  });
});

describe('legacy mode with a first-party cookie left from before a rollback (review M2)', () => {
  const FIRST_PARTY_CLEARS = [
    '__Secure-boardsesh.session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    '__Secure-boardsesh.session_token=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    '__Secure-boardsesh.bridged_session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    '__Secure-boardsesh.bridged_session_token=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    // The viewer marker is cleared with them; legacy mode never writes one.
    '__Secure-boardsesh.viewer=; Path=/; Max-Age=0; SameSite=Lax; Secure',
    '__Secure-boardsesh.viewer=; Path=/; Domain=.boardsesh.com; Max-Age=0; SameSite=Lax; Secure',
  ];
  afterEach(() => {
    carriedFirstParty = '';
  });

  it('adds the first-party clears to login and sign-out only, needing no cookie secret', async () => {
    const plain = await routeAnswers();
    const plainCsrf = await normalizedResponse(await callRoute(authRoute, '/api/auth/csrf'));
    // Any value, verified or not: www holds no cookie secret in legacy mode.
    carriedFirstParty = '__Secure-boardsesh.session_token=stale.value; __Secure-boardsesh.bridged_session_token=other';
    const carried = await routeAnswers();
    expect(carried.loginRight.setCookies).toEqual([...plain.loginRight.setCookies, ...FIRST_PARTY_CLEARS]);
    expect(carried.signOutShownLogin.setCookies).toEqual([
      ...plain.signOutShownLogin.setCookies,
      ...FIRST_PARTY_CLEARS,
    ]);
    for (const unchanged of ['loginWrong', 'sessionSignedIn', 'sessionAnonymous', 'signOutOtherLogin'] as const)
      expect(carried[unchanged]).toEqual(plain[unchanged]);
    expect(
      await normalizedResponse(await callRoute(authRoute, '/api/auth/csrf', { cookie: carriedFirstParty })),
    ).toEqual(plainCsrf);
  });
});
