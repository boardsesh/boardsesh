// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import type { Adapter, AdapterAccount, AdapterUser } from 'next-auth/adapters';
import { decode, encode, type JWT } from 'next-auth/jwt';
import type { OAuthConfig } from 'next-auth/providers/oauth';

const { baseUrl, sessionSecret } = vi.hoisted(() => {
  const fixtureUrl = 'http://localhost:3000';
  const fixtureSecret = 'oauth-link-guard-fixture-secret';
  // auth-options reads both while it is imported, before any test body runs.
  process.env.NEXTAUTH_URL = fixtureUrl;
  process.env.NEXTAUTH_SECRET = fixtureSecret;
  return { baseUrl: fixtureUrl, sessionSecret: fixtureSecret };
});

const database = vi.hoisted(() => ({ rows: new Map<unknown, unknown[]>(), failing: false }));

vi.mock('server-only', () => ({}));
vi.mock('@auth/drizzle-adapter', () => ({ DrizzleAdapter: vi.fn(() => ({})) }));
// Reads answer per table: the guard's password read, and the callbacks'
// best-effort profile and attribution reads, which find nothing.
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (database.failing) throw new Error('database unavailable');
            return database.rows.get(table) ?? [];
          },
        }),
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
  }),
}));
// Admission is a backend round trip with its own coverage; it reads only `sub`.
vi.mock('@/app/lib/auth/auth-response-admission.server', () => ({
  withAuthResponseAdmission: (_request: unknown, _context: unknown, invoke: () => Promise<Response>) => invoke(),
}));

import { isLinkGuardedSignIn } from '@boardsesh/auth-protocol/auth-time';
import { GET } from '@/app/api/auth/[...nextauth]/route';
import * as schema from '@/app/lib/db/schema';
import { authOptions } from '../auth-options';

// The production route, NextAuth handler, callback handler, callbacks and JWE
// encoder all run. Only the provider's two network calls, the database and
// Next's ambient request I/O are replaced.
const requestStorage = new AsyncLocalStorage<NextRequest>();
const require = createRequire(import.meta.url);
const nextIo = require('next/headers') as {
  headers: () => Promise<Headers>;
  cookies: () => Promise<{ getAll: () => { name: string; value: string }[] }>;
};

const SESSION_COOKIE = 'next-auth.session-token';
const NOW_MS = Date.UTC(2026, 10, 10, 12, 0, 0);
const NOW_SECONDS = NOW_MS / 1000;
const DAY_SECONDS = 24 * 60 * 60;

const users = new Map<string, AdapterUser>();
const links = new Map<string, string>();
const linkAccount = vi.fn(async (account: AdapterAccount) => {
  links.set(`${account.provider}:${account.providerAccountId}`, account.userId);
  return account;
});
let createdUsers = 0;

const memoryAdapter: Adapter = {
  async createUser(user: Omit<AdapterUser, 'id'>) {
    createdUsers += 1;
    const created = { ...user, id: `created-${createdUsers}` };
    users.set(created.id, created);
    return created;
  },
  async getUser(id: string) {
    return users.get(id) ?? null;
  },
  async getUserByEmail(email: string) {
    return [...users.values()].find((user) => user.email === email) ?? null;
  },
  async getUserByAccount({ provider, providerAccountId }: Pick<AdapterAccount, 'provider' | 'providerAccountId'>) {
    const userId = links.get(`${provider}:${providerAccountId}`);
    return userId ? (users.get(userId) ?? null) : null;
  },
  async updateUser(user: Partial<AdapterUser> & Pick<AdapterUser, 'id'>) {
    const updated = { ...users.get(user.id!)!, ...user } as AdapterUser;
    users.set(updated.id, updated);
    return updated;
  },
  linkAccount,
};

/** Whose Google account the provider says signed in. */
let providerProfile: { sub: string; email: string; name: string };

const stubGoogle: OAuthConfig<{ sub: string; email: string; name: string }> = {
  id: 'google',
  name: 'Google',
  type: 'oauth',
  clientId: 'stub-client',
  clientSecret: 'stub-secret',
  checks: ['none'],
  idToken: false,
  allowDangerousEmailAccountLinking: true,
  authorization: { url: 'https://provider.example.test/authorize' },
  token: {
    url: 'https://provider.example.test/token',
    async request() {
      return { tokens: { access_token: 'provider-access-token', token_type: 'bearer' } };
    },
  },
  userinfo: {
    url: 'https://provider.example.test/userinfo',
    async request() {
      return providerProfile;
    },
  },
  profile: (profile) => ({ id: profile.sub, email: profile.email, name: profile.name, image: null }),
};

const climber: AdapterUser = {
  id: 'climber-with-an-old-cookie',
  email: 'climber@example.com',
  name: 'Climber',
  image: null,
  emailVerified: new Date('2026-01-01T00:00:00.000Z'),
};

async function sessionCookie(claims: Record<string, unknown>): Promise<string> {
  return encode({
    token: { sub: climber.id, email: climber.email, authSessionId: 'an-earlier-login', ...claims },
    secret: sessionSecret,
  });
}

async function providerCallback(cookie?: string): Promise<Response> {
  const request = new NextRequest(`${baseUrl}/api/auth/callback/google?code=provider-code`, {
    headers: cookie ? { Cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });
  const context = { params: Promise.resolve({ nextauth: ['callback', 'google'] }) };
  return requestStorage.run(request, () => GET(request, context));
}

function issuedSession(response: Response): Promise<JWT | null> | null {
  const header = response.headers.getSetCookie().find((candidate) => candidate.startsWith(`${SESSION_COOKIE}=`));
  if (!header) return null;
  return decode({ token: header.split(';')[0].slice(SESSION_COOKIE.length + 1), secret: sessionSecret });
}

beforeAll(() => {
  vi.spyOn(nextIo, 'headers').mockImplementation(async () => requestStorage.getStore()?.headers ?? new Headers());
  vi.spyOn(nextIo, 'cookies').mockImplementation(async () => ({
    getAll: () => requestStorage.getStore()?.cookies.getAll() ?? [],
  }));
  authOptions.providers.push(stubGoogle);
  authOptions.adapter = memoryAdapter;
  // NextAuth prints the refused callback; it is the expected outcome here.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW_MS });
  database.rows.clear();
  database.failing = false;
  users.clear();
  links.clear();
  linkAccount.mockClear();
  createdUsers = 0;
  users.set(climber.id, climber);
  providerProfile = { sub: 'someone-elses-google-account', email: 'holder@example.com', name: 'Holder' };
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const STALE_SESSIONS: Array<[string, Record<string, unknown>]> = [
  ['from before the auth_time claim', {}],
  ['40 days old', { auth_time: NOW_SECONDS - 40 * DAY_SECONDS }],
  ['exactly 30 days old', { auth_time: NOW_SECONDS - 30 * DAY_SECONDS }],
  ['with a fractional sign-in time', { auth_time: NOW_SECONDS - 0.5 }],
  ['with a sign-in time in the future', { auth_time: NOW_SECONDS + 3600 }],
  ['with a sign-in time that is not a number', { auth_time: String(NOW_SECONDS) }],
  ['with a non-positive sign-in time', { auth_time: 0 }],
];

/** A sign-in five days ago, made while the web guarded links. */
const GUARDED_SIGN_IN = { auth_time: NOW_SECONDS - 5 * DAY_SECONDS, link_guarded: true };

/** Partner OAuth modes the backend could be in, as the web reads them. */
const MODES_OFF: Array<[string, string | undefined]> = [
  ['unset', undefined],
  ['off', 'off'],
  ['empty', ''],
  ['misspelled', 'allowlst'],
];
const MODES_ON: Array<[string, string]> = [
  ['allowlist', 'allowlist'],
  ['hold', 'hold'],
  ['open', 'Open '],
];

function withPartnerMode(rawMode: string | undefined) {
  beforeEach(() => {
    vi.stubEnv('PARTNER_OAUTH_MODE', rawMode);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
}

function passwordChangedAt(changedAtSeconds: number) {
  database.rows.set(schema.userCredentials, [{ updatedAt: new Date(changedAtSeconds * 1000) }]);
}

function expectRefused(response: Response) {
  expect(response.status).toBe(302);
  expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('Callback');
  expect(linkAccount).not.toHaveBeenCalled();
  expect(links.size).toBe(0);
  expect(issuedSession(response)).toBeNull();
}

async function expectLinked(response: Response) {
  expect(linkAccount).toHaveBeenCalledWith(
    expect.objectContaining({ userId: climber.id, provider: 'google', providerAccountId: providerProfile.sub }),
  );
  const session = await issuedSession(response);
  expect(session?.sub).toBe(climber.id);
  expect(session?.auth_time).toBe(NOW_SECONDS);
  return session;
}

// Every cookie from before F5 lacks auth_time, so the guard waits for partner
// consent to exist. Until then a link behaves exactly as it always has.
describe.each(MODES_OFF)('with partner OAuth %s', (_label, rawMode) => {
  withPartnerMode(rawMode);

  it.each(STALE_SESSIONS)('links into a session %s, as today', async (_session, claims) => {
    const session = await expectLinked(await providerCallback(await sessionCookie(claims)));
    // A sign-in made with the guard off never says it was guarded.
    expect(session).not.toHaveProperty('link_guarded');
  });

  it('links into a session from before a password change, as today', async () => {
    passwordChangedAt(NOW_SECONDS - DAY_SECONDS);
    await expectLinked(await providerCallback(await sessionCookie(GUARDED_SIGN_IN)));
  });
});

describe.each(MODES_ON)('with partner OAuth %s', (_label, rawMode) => {
  withPartnerMode(rawMode);

  it.each(STALE_SESSIONS)('refuses a link into a session %s, and mints no sign-in time', async (_session, claims) => {
    expectRefused(await providerCallback(await sessionCookie(claims)));
  });

  it('refuses a recent sign-in made while the guard was off, so it cannot be laundered', async () => {
    expectRefused(await providerCallback(await sessionCookie({ auth_time: NOW_SECONDS - DAY_SECONDS })));
  });

  it('refuses a session from before the last password change', async () => {
    passwordChangedAt(NOW_SECONDS - DAY_SECONDS);
    expectRefused(await providerCallback(await sessionCookie(GUARDED_SIGN_IN)));
  });

  it('refuses a sign-in inside the clock tolerance after a password change', async () => {
    passwordChangedAt(GUARDED_SIGN_IN.auth_time - 30);
    expectRefused(await providerCallback(await sessionCookie(GUARDED_SIGN_IN)));
  });

  it('refuses when the password write cannot be read', async () => {
    database.failing = true;
    expectRefused(await providerCallback(await sessionCookie(GUARDED_SIGN_IN)));
  });

  it('links into a guarded sign-in made over a minute after the last password change', async () => {
    passwordChangedAt(GUARDED_SIGN_IN.auth_time - 61);
    const session = await expectLinked(await providerCallback(await sessionCookie(GUARDED_SIGN_IN)));
    expect(session?.link_guarded).toBe(true);
  });
});

describe.each([...MODES_OFF.slice(0, 1), ...MODES_ON.slice(0, 1)])(
  'first-party OAuth sign-in with partner OAuth %s',
  (_label, rawMode) => {
    withPartnerMode(rawMode);
    const guarded = rawMode !== undefined;

    it('links into a guarded session signed in under 30 days ago', async () => {
      await expectLinked(
        await providerCallback(await sessionCookie({ auth_time: NOW_SECONDS - 29 * DAY_SECONDS, link_guarded: true })),
      );
    });

    it('signs in a provider account already linked to the climber, even from an old session', async () => {
      links.set(`google:${providerProfile.sub}`, climber.id);
      const response = await providerCallback(await sessionCookie({ auth_time: NOW_SECONDS - 40 * DAY_SECONDS }));

      expect(linkAccount).not.toHaveBeenCalled();
      const session = await issuedSession(response);
      expect(session?.sub).toBe(climber.id);
      expect(session?.auth_time).toBe(NOW_SECONDS);
    });

    it('creates and links a new account when no one is signed in', async () => {
      const response = await providerCallback();

      expect(linkAccount).toHaveBeenCalledWith(expect.objectContaining({ userId: 'created-1' }));
      const session = await issuedSession(response);
      expect(session?.sub).toBe('created-1');
      expect(session?.auth_time).toBe(NOW_SECONDS);
      // Written beside auth_time only while links are guarded, under the name the backend reads.
      expect(isLinkGuardedSignIn(session ?? {})).toBe(guarded);
    });

    it('links by verified provider email when no one is signed in', async () => {
      providerProfile = { sub: 'climbers-own-google-account', email: climber.email, name: 'Climber' };
      const response = await providerCallback();

      expect(linkAccount).toHaveBeenCalledWith(expect.objectContaining({ userId: climber.id }));
      expect((await issuedSession(response))?.sub).toBe(climber.id);
    });

    it('treats an expired session cookie as no session, as NextAuth does', async () => {
      vi.setSystemTime(NOW_MS - 31 * DAY_SECONDS * 1000);
      const expired = await sessionCookie({ auth_time: NOW_SECONDS - 31 * DAY_SECONDS });
      vi.setSystemTime(NOW_MS);
      const response = await providerCallback(expired);

      expect(linkAccount).toHaveBeenCalledWith(expect.objectContaining({ userId: 'created-1' }));
      expect((await issuedSession(response))?.sub).toBe('created-1');
    });
  },
);
