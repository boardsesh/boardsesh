import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { PrototypeAuthority } from '../authority';
import { createPrototypeEnvironment } from '../environment';
import {
  createFacebookPrototypeOptions,
  PROTOTYPE_FACEBOOK_CALLBACK_URL,
  PROTOTYPE_FACEBOOK_CLIENT_ID,
  PROTOTYPE_FACEBOOK_CLIENT_SECRET,
} from '../facebook-providers';
import { planPrototypeIdentityImport, type PrototypeLegacyIdentity } from '../identity-fixtures';
import { PROTOTYPE_ISSUER } from '../oauth-options';
import { createSerializedPrototypeOAuthHandler } from '../oauth-transaction';

const callbackURL = 'https://www.boardsesh.test/settings?source=facebook#account';
const errorCallbackURL = 'https://www.boardsesh.test/auth/login?source=facebook';

interface GraphProfileFixture {
  id: string;
  name: string;
  email?: string;
  email_verified?: boolean;
  picture: { data: { url: string; width: number; height: number; is_silhouette: boolean } };
}

interface ProviderFixture {
  profile: GraphProfileFixture;
  tokenAppId?: string;
  tokenSubject?: string;
  tokenValid?: boolean;
  profileFailure?: boolean;
  tokenRedirect?: boolean;
}

function cookieHeader(response: Response, name?: string) {
  const headers = response.headers.getSetCookie().filter((header) => !name || header.includes(name));
  return headers.map((header) => header.split(';')[0]).join('; ');
}

describe('pinned Facebook browser authorization and callback integration', () => {
  let environment: Awaited<ReturnType<typeof createPrototypeEnvironment>>;
  let primary: Pick<PrototypeAuthority, 'handler'>;
  let secondary: Pick<PrototypeAuthority, 'handler'>;
  let providerOptions: ReturnType<typeof createFacebookPrototypeOptions>;
  const pendingCodes = new Map<string, ProviderFixture>();
  const accessTokens = new Map<string, ProviderFixture>();
  const providerRequests: string[] = [];

  function response(body: unknown, status = 200) {
    return Response.json(body, { status });
  }

  async function providerTransport(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    providerRequests.push(url.pathname);
    if (url.origin !== 'https://graph.facebook.com') throw new Error('Unexpected outbound Facebook prototype origin');
    if (url.pathname === '/v24.0/oauth/access_token') {
      expect(request.method).toBe('POST');
      expect(request.redirect).toBe('manual');
      const form = new URLSearchParams(await request.text());
      expect(form.get('redirect_uri')).toBe(PROTOTYPE_FACEBOOK_CALLBACK_URL);
      expect(form.get('client_id')).toBe(PROTOTYPE_FACEBOOK_CLIENT_ID);
      expect(form.get('client_secret')).toBe(PROTOTYPE_FACEBOOK_CLIENT_SECRET);
      const code = form.get('code') ?? '';
      const fixture = pendingCodes.get(code);
      if (!fixture)
        return response({ error: { type: 'OAuthException', message: 'Synthetic invalid or consumed code' } }, 400);
      pendingCodes.delete(code);
      if (fixture.tokenRedirect)
        return new Response(null, { status: 302, headers: { location: 'https://attacker.example/token' } });
      const accessToken = `synthetic-facebook-access-${randomUUID()}`;
      accessTokens.set(accessToken, fixture);
      return response({ access_token: accessToken, token_type: 'bearer', expires_in: 3600 });
    }
    if (url.pathname === '/debug_token') {
      expect(url.searchParams.get('access_token')).toBe(
        `${PROTOTYPE_FACEBOOK_CLIENT_ID}|${PROTOTYPE_FACEBOOK_CLIENT_SECRET}`,
      );
      const fixture = accessTokens.get(url.searchParams.get('input_token') ?? '');
      if (!fixture) return response({ data: { is_valid: false } });
      return response({
        data: {
          is_valid: fixture.tokenValid ?? true,
          app_id: fixture.tokenAppId ?? PROTOTYPE_FACEBOOK_CLIENT_ID,
          user_id: fixture.tokenSubject ?? fixture.profile.id,
        },
      });
    }
    if (url.pathname === '/me') {
      expect(url.searchParams.get('fields')?.split(',')).toEqual(['id', 'name', 'email', 'picture']);
      const authorization = request.headers.get('authorization');
      const fixture = authorization?.startsWith('Bearer ') ? accessTokens.get(authorization.slice(7)) : undefined;
      if (!fixture || fixture.profileFailure) return response({ error: { message: 'Synthetic Graph rejection' } }, 400);
      return response(fixture.profile);
    }
    throw new Error('Unexpected outbound Facebook prototype path');
  }

  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    providerOptions = createFacebookPrototypeOptions(async (subject) => {
      const matched = await environment.database
        .select({
          email: environment.schema.user.email,
          name: environment.schema.user.name,
          emailVerified: environment.schema.user.emailVerified,
        })
        .from(environment.schema.account)
        .innerJoin(environment.schema.user, eq(environment.schema.user.id, environment.schema.account.userId))
        .where(
          and(eq(environment.schema.account.providerId, 'facebook'), eq(environment.schema.account.accountId, subject)),
        )
        .limit(1);
      return matched[0] ?? null;
    });
    primary = createSerializedPrototypeOAuthHandler(environment.database, providerOptions);
    secondary = createSerializedPrototypeOAuthHandler(environment.database, providerOptions);
  });

  beforeEach(() => {
    pendingCodes.clear();
    accessTokens.clear();
    providerRequests.length = 0;
    // Replace only Meta's HTTP responses. Real Better Auth state/cookies,
    // provider code/token/profile validation, adapter and Postgres run intact.
    vi.stubGlobal('fetch', vi.fn(providerTransport));
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => environment?.close());

  async function seedIdentity(overrides: Partial<PrototypeLegacyIdentity> = {}) {
    const id = randomUUID();
    const fixture: PrototypeLegacyIdentity = {
      id,
      email: `facebook-${id}@example.com`,
      name: 'Imported Facebook climber',
      image: null,
      emailVerifiedAt: new Date('2024-02-03T04:05:06Z'),
      createdAt: new Date('2023-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-01T00:00:00Z'),
      passwordHash: null,
      providers: [{ provider: 'facebook', subject: `facebook-subject-${id}` }],
      ...overrides,
    };
    const plan = planPrototypeIdentityImport([fixture]);
    await environment.database.transaction(async (transaction) => {
      await transaction.insert(environment.schema.user).values(plan.users);
      if (plan.accounts.length > 0) await transaction.insert(environment.schema.account).values(plan.accounts);
    });
    return fixture;
  }

  function codeFor(
    identity: PrototypeLegacyIdentity,
    overrides: Partial<ProviderFixture> = {},
    profileOverrides: Partial<GraphProfileFixture> = {},
  ) {
    const code = `synthetic-facebook-code-${randomUUID()}`;
    const subject =
      identity.providers.find((provider) => provider.provider === 'facebook')?.subject ?? `unknown-${randomUUID()}`;
    pendingCodes.set(code, {
      profile: {
        id: subject,
        name: 'Fresh provider display name',
        email: identity.email,
        email_verified: true,
        picture: {
          data: { url: 'https://pictures.example/facebook-fixture.jpg', height: 64, width: 64, is_silhouette: false },
        },
        ...profileOverrides,
      },
      ...overrides,
    });
    return code;
  }

  async function begin(overrides: Record<string, string> = {}, authority = primary) {
    const started = await authority.handler(
      new Request(`${PROTOTYPE_ISSUER}/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://www.boardsesh.test' },
        body: JSON.stringify({
          provider: 'facebook',
          disableRedirect: true,
          callbackURL,
          errorCallbackURL,
          ...overrides,
        }),
      }),
    );
    expect(started.status).toBe(200);
    const payload = (await started.json()) as { url: string; redirect: boolean };
    const authorization = new URL(payload.url);
    expect(authorization.origin).toBe('https://www.facebook.com');
    expect(authorization.pathname).toBe('/v24.0/dialog/oauth');
    expect(authorization.searchParams.get('client_id')).toBe(PROTOTYPE_FACEBOOK_CLIENT_ID);
    expect(authorization.searchParams.get('redirect_uri')).toBe(PROTOTYPE_FACEBOOK_CALLBACK_URL);
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('scope')?.split(' ')).toEqual(['email', 'public_profile']);
    const state = authorization.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(cookieHeader(started)).toContain('better-auth.state=');
    return { state: state!, cookie: cookieHeader(started) };
  }

  function callback(
    started: { state: string; cookie: string },
    fields: Record<string, string>,
    cookie = started.cookie,
    authority = secondary,
  ) {
    const callback = new URL(PROTOTYPE_FACEBOOK_CALLBACK_URL);
    callback.search = new URLSearchParams({ state: started.state, ...fields }).toString();
    return authority.handler(new Request(callback, { headers: { cookie } }));
  }

  function expectCallbackError(callback: Response, error: string) {
    expect(callback.status).toBe(302);
    const destination = new URL(callback.headers.get('location')!);
    expect(destination.searchParams.get('error')).toBe(error);
    expect(cookieHeader(callback, 'better-auth.session_token=')).toBe('');
  }

  async function authenticatedUser(callback: Response) {
    const cookie = cookieHeader(callback, 'better-auth.session_token=');
    expect(cookie).not.toBe('');
    const session = await primary.handler(new Request(`${PROTOTYPE_ISSUER}/get-session`, { headers: { cookie } }));
    expect(session.status).toBe(200);
    return (await session.json()) as { user: { id: string; email: string; name: string; emailVerified: boolean } };
  }

  it('exchanges on a second authority and preserves the declared callback and imported subject', async () => {
    const identity = await seedIdentity();
    const started = await begin();
    const completed = await callback(started, {
      code: codeFor(identity),
      callbackURL: 'https://attacker.example/override',
    });
    expect(completed.status).toBe(302);
    expect(completed.headers.get('location')).toBe(callbackURL);
    expect(await authenticatedUser(completed)).toMatchObject({ user: { id: identity.id, email: identity.email } });
    expect(completed.headers.getSetCookie().find((cookie) => cookie.includes('better-auth.session_token='))).toContain(
      'HttpOnly',
    );
    expect(providerRequests).toEqual(['/v24.0/oauth/access_token', '/debug_token', '/me']);
    const [provider] = await environment.database
      .select()
      .from(environment.schema.account)
      .where(
        and(eq(environment.schema.account.userId, identity.id), eq(environment.schema.account.providerId, 'facebook')),
      );
    expect(provider.accountId).toBe(identity.providers[0].subject);
  });

  it('keeps the imported subject owner when the provider email now matches another account', async () => {
    const identity = await seedIdentity();
    const another = await seedIdentity({ providers: [] });
    const completed = await callback(await begin(), { code: codeFor(identity, {}, { email: another.email }) });
    expect(await authenticatedUser(completed)).toMatchObject({ user: { id: identity.id, email: identity.email } });
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, another.id)),
    ).toEqual([]);
  });

  it('uses persisted subject mapping for an imported user when Facebook omits email', async () => {
    const identity = await seedIdentity({ emailVerifiedAt: null });
    const completed = await callback(await begin(), { code: codeFor(identity, {}, { email: undefined }) });
    expect(completed.headers.get('location')).toBe(callbackURL);
    expect(await authenticatedUser(completed)).toMatchObject({
      user: { id: identity.id, email: identity.email, name: identity.name, emailVerified: false },
    });
    const [stored] = await environment.database
      .select()
      .from(environment.schema.user)
      .where(eq(environment.schema.user.id, identity.id));
    expect(stored.legacyEmailVerifiedAt).toBeNull();
    expect(stored.emailVerified).toBe(false);
  });

  it('rejects an unlinked Facebook identity even when its verified email matches', async () => {
    const identity = await seedIdentity();
    const unlinkedSubject = `unlinked-${randomUUID()}`;
    const completed = await callback(await begin(), {
      code: codeFor(identity, {}, { id: unlinkedSubject, email_verified: true }),
    });
    expectCallbackError(completed, 'account_not_linked');
    expect(
      await environment.database
        .select()
        .from(environment.schema.account)
        .where(eq(environment.schema.account.accountId, unlinkedSubject)),
    ).toEqual([]);
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, identity.id)),
    ).toEqual([]);
  });

  it('rejects an unknown Facebook subject without creating a placeholder email/account', async () => {
    const identity = await seedIdentity();
    const unknownSubject = `unknown-${randomUUID()}`;
    const completed = await callback(await begin(), {
      code: codeFor(identity, {}, { id: unknownSubject, email: undefined }),
    });
    expectCallbackError(completed, 'email_not_found');
    expect(
      await environment.database
        .select()
        .from(environment.schema.account)
        .where(eq(environment.schema.account.accountId, unknownSubject)),
    ).toEqual([]);
  });

  it.each(['missing', 'other-flow', 'tampered'] as const)(
    'rejects %s state cookies before exchanging a provider code',
    async (variant) => {
      const identity = await seedIdentity();
      const started = await begin();
      const otherFlow = await begin();
      const cookie =
        variant === 'missing' ? '' : variant === 'other-flow' ? otherFlow.cookie : `${started.cookie}tampered`;
      const completed = await callback(started, { code: codeFor(identity) }, cookie);
      expectCallbackError(completed, 'state_mismatch');
      expect(providerRequests).toEqual([]);
      expect(
        await environment.database
          .select()
          .from(environment.schema.session)
          .where(eq(environment.schema.session.userId, identity.id)),
      ).toEqual([]);
    },
  );

  it('rejects a substituted state parameter before exchanging a provider code', async () => {
    const identity = await seedIdentity();
    const started = await begin();
    const completed = await callback(started, { code: codeFor(identity), state: 'unknown-state' });
    expectCallbackError(completed, 'state_mismatch');
    expect(providerRequests).toEqual([]);
  });

  it('consumes callback state so another authority cannot replay the completed flow', async () => {
    const identity = await seedIdentity();
    const started = await begin();
    const code = codeFor(identity);
    expect((await callback(started, { code })).headers.get('location')).toBe(callbackURL);
    const replay = await callback(started, { code }, started.cookie, primary);
    expectCallbackError(replay, 'state_mismatch');
    expect(providerRequests.filter((path) => path === '/v24.0/oauth/access_token')).toHaveLength(1);
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, identity.id)),
    ).toHaveLength(1);
  });

  it('returns provider cancellation to the validated error callback without exchanging a code', async () => {
    const started = await begin();
    const completed = await callback(started, {
      error: 'access_denied',
      error_description: 'User cancelled synthetic provider consent',
    });
    expectCallbackError(completed, 'access_denied');
    const destination = new URL(completed.headers.get('location')!);
    expect(destination.origin + destination.pathname).toBe('https://www.boardsesh.test/auth/login');
    expect(destination.searchParams.get('source')).toBe('facebook');
    expect(providerRequests).toEqual([]);
    expectCallbackError(await callback(started, { code: 'not-exchanged' }), 'state_mismatch');
  });

  it('rejects invalid authorization codes without creating a session', async () => {
    const identity = await seedIdentity();
    expectCallbackError(await callback(await begin(), { code: 'provider-rejected-code' }), 'invalid_code');
    expect(providerRequests).toEqual(['/v24.0/oauth/access_token']);
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, identity.id)),
    ).toEqual([]);
  });

  it.each([
    ['another app', { tokenAppId: 'unrelated-facebook-app' }],
    ['an invalid token', { tokenValid: false }],
    ['a different Graph subject', { tokenSubject: 'another-facebook-subject' }],
    ['a rejected profile', { profileFailure: true }],
  ] as const)('rejects provider responses for %s', async (_reason, providerOverrides) => {
    const identity = await seedIdentity();
    const completed = await callback(await begin(), { code: codeFor(identity, providerOverrides) });
    expectCallbackError(completed, 'unable_to_get_user_info');
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, identity.id)),
    ).toEqual([]);
  });

  it('refuses a redirect from the provider token endpoint instead of forwarding app credentials', async () => {
    const identity = await seedIdentity();
    const completed = await callback(await begin(), { code: codeFor(identity, { tokenRedirect: true }) });
    expectCallbackError(completed, 'invalid_code');
    expect(providerRequests).toEqual(['/v24.0/oauth/access_token']);
  });

  it('characterizes raw stock state consumption racing two different valid provider codes', async () => {
    const firstIdentity = await seedIdentity();
    const secondIdentity = await seedIdentity();
    let readersAtDeletion = 0;
    let releaseBothReaders!: () => void;
    const bothReadersReachedDeletion = new Promise<void>((resolve) => {
      releaseBothReaders = resolve;
    });
    const overrides = {
      ...providerOptions,
      databaseHooks: {
        verification: {
          delete: {
            async before(verification: { identifier: string }) {
              if (!verification.identifier.startsWith('auth-state:')) return;
              // A documented DB hook controls scheduling only: both stock
              // callbacks have already read the same valid state before delete.
              readersAtDeletion += 1;
              if (readersAtDeletion === 2) releaseBothReaders();
              await bothReadersReachedDeletion;
            },
          },
        },
      },
    };
    const firstRaw = environment.createAuthority(overrides);
    const secondRaw = environment.createAuthority(overrides);
    await Promise.all([firstRaw.$context, secondRaw.$context]);
    const started = await begin({}, firstRaw);
    const completed = await Promise.all([
      callback(started, { code: codeFor(firstIdentity) }, started.cookie, firstRaw),
      callback(started, { code: codeFor(secondIdentity) }, started.cookie, secondRaw),
    ]);
    // A passing characterization records a blocker in the raw configuration.
    // It does not claim that accepting both subjects is safe migration behavior.
    expect(readersAtDeletion).toBe(2);
    expect(completed.map((result) => result.headers.get('location'))).toEqual([callbackURL, callbackURL]);
    expect((await authenticatedUser(completed[0])).user.id).toBe(firstIdentity.id);
    expect((await authenticatedUser(completed[1])).user.id).toBe(secondIdentity.id);
  });

  it('serializes competing callbacks so one state authenticates only one imported subject', async () => {
    const firstIdentity = await seedIdentity();
    const secondIdentity = await seedIdentity();
    const started = await begin();
    const completed = await Promise.all([
      callback(started, { code: codeFor(firstIdentity) }, started.cookie, primary),
      callback(started, { code: codeFor(secondIdentity) }, started.cookie, secondary),
    ]);
    const successful = completed.filter((result) => result.headers.get('location') === callbackURL);
    const rejected = completed.filter((result) => result.headers.get('location') !== callbackURL);
    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expectCallbackError(rejected[0], 'state_mismatch');
    expect([firstIdentity.id, secondIdentity.id]).toContain((await authenticatedUser(successful[0])).user.id);
    expect(providerRequests.filter((path) => path === '/v24.0/oauth/access_token')).toHaveLength(1);
  });

  it('rolls back session/account changes and state consumption after a post-session provider-handler failure', async () => {
    const identity = await seedIdentity();
    const started = await begin();
    const failing = createSerializedPrototypeOAuthHandler(environment.database, {
      ...providerOptions,
      databaseHooks: {
        session: {
          create: {
            async after() {
              throw new Error('Synthetic Facebook session failure');
            },
          },
        },
      },
    });
    const completed = await callback(started, { code: codeFor(identity) }, started.cookie, failing);
    expect(completed.status).toBe(500);
    expect(cookieHeader(completed, 'better-auth.session_token=')).toBe('');
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, identity.id)),
    ).toEqual([]);
    const [storedAccount] = await environment.database
      .select()
      .from(environment.schema.account)
      .where(
        and(eq(environment.schema.account.userId, identity.id), eq(environment.schema.account.providerId, 'facebook')),
      );
    expect(storedAccount.accessToken).toBeNull();
    expect(
      await environment.database
        .select()
        .from(environment.schema.verification)
        .where(eq(environment.schema.verification.identifier, `auth-state:${started.state}`)),
    ).toHaveLength(1);
    // External provider code consumption cannot roll back with our database.
    // The browser must restart provider authorization after this failure.
    expect(providerRequests.filter((path) => path === '/v24.0/oauth/access_token')).toHaveLength(1);
  });

  it.each(['callbackURL', 'errorCallbackURL'] as const)(
    'rejects an untrusted %s before starting Facebook authorization',
    async (field) => {
      const response = await primary.handler(
        new Request(`${PROTOTYPE_ISSUER}/sign-in/social`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://www.boardsesh.test' },
          body: JSON.stringify({
            provider: 'facebook',
            callbackURL,
            errorCallbackURL,
            [field]: 'https://attacker.example/auth',
          }),
        }),
      );
      expect(response.status).toBe(403);
      expect(cookieHeader(response, 'better-auth.state=')).toBe('');
      expect(providerRequests).toEqual([]);
    },
  );
});
