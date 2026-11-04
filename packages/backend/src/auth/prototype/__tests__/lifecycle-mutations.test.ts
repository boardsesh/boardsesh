import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { PROTOTYPE_CONFIGURATION } from '../configuration';
import { createIdentityPrototypeOptions, PROTOTYPE_GOOGLE_AUDIENCES } from '../identity-providers';
import { planPrototypeIdentityImport } from '../identity-fixtures';
import { createPrototypeNativeFacade } from '../identity-native-facade';
import { createPrototypeLegacyHandler, PROTOTYPE_LEGACY_KEY } from '../legacy-bridge';
import {
  bindPrototypeLegacyRecoveryLinks,
  createPrototypeLegacyRecoveryFacade,
  type PrototypeLegacyRecoverySnapshot,
} from '../legacy-recovery';
import { createPrototypeLifecycleMutations, PROTOTYPE_LIFECYCLE_PATHS } from '../lifecycle-mutations';
import { createSerializedPrototypeOAuthHandler } from '../oauth-transaction';
import { PROTOTYPE_ISSUER, PROTOTYPE_RESOURCE } from '../oauth-options';

const originalPassword = 'original-lifecycle-password';
const nextPassword = ' café-山-🧗-new-password ';
const nativeKey = new TextEncoder().encode('boardsesh-disposable-lifecycle-native-key');

function cookieHeader(response: Response) {
  return response.headers
    .getSetCookie()
    .filter((cookie) => cookie.includes('better-auth.session_token='))
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

describe('canonical credential mutations through supported Better Auth APIs', () => {
  let environment: Awaited<ReturnType<typeof createPrototypeEnvironment>>;
  let authority: ReturnType<typeof environment.createAuthority>;
  let originalPasswordHash: string;
  let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
  let cutoverAt: Date;
  let providerOptions: ReturnType<typeof createIdentityPrototypeOptions>;

  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    cutoverAt = new Date();
    originalPasswordHash = await hash(originalPassword, 4);
    const keyPair = await generateKeyPair('RS256');
    signingKey = keyPair.privateKey;
    publicJwk = await exportJWK(keyPair.publicKey);
    providerOptions = createIdentityPrototypeOptions(async () => null);
    authority = environment.createAuthority(providerOptions);
    await authority.$context;
  });

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url !== 'https://www.googleapis.com/oauth2/v3/certs')
          throw new Error('Unexpected lifecycle provider transport');
        return Response.json({ keys: [{ ...publicJwk, kid: 'lifecycle-google-key', alg: 'RS256', use: 'sig' }] });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => environment?.close());

  async function fixture(passwordPresent = true) {
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    const subject = `google-lifecycle-${userId}`;
    const plan = planPrototypeIdentityImport([
      {
        id: userId,
        email,
        name: 'Lifecycle fixture',
        image: null,
        emailVerifiedAt: null,
        createdAt: new Date('2023-01-01T00:00:00Z'),
        updatedAt: new Date(),
        passwordHash: passwordPresent ? originalPasswordHash : null,
        providers: [{ provider: 'google', subject }],
      },
    ]);
    await environment.database.transaction(async (transaction) => {
      await transaction.insert(environment.schema.user).values(plan.users);
      await transaction.insert(environment.schema.account).values(plan.accounts);
    });
    const token = await new SignJWT({ email, email_verified: false, name: 'Lifecycle fixture' })
      .setProtectedHeader({ alg: 'RS256', kid: 'lifecycle-google-key' })
      .setSubject(subject)
      .setIssuer('https://accounts.google.com')
      .setAudience(PROTOTYPE_GOOGLE_AUDIENCES[0])
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(signingKey);
    const signedIn = await authority.api.signInSocial({
      body: { provider: 'google', idToken: { token } },
      asResponse: true,
    });
    expect(signedIn.status).toBe(200);
    const cookie = cookieHeader(signedIn);
    expect(cookie).not.toBe('');
    const session = await authority.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.id).toBe(userId);
    return { userId, email, subject, cookie, sessionId: session!.session.id };
  }

  function mutationRequest(path: string, cookie: string, body: Record<string, unknown>) {
    return new Request(`${PROTOTYPE_ISSUER}${path}`, {
      method: 'POST',
      headers: { cookie, origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function mutate(
    kind: 'change' | 'set',
    cookie: string,
    newPassword = nextPassword,
    instance = createPrototypeLifecycleMutations(environment.database),
  ) {
    const path = kind === 'change' ? PROTOTYPE_LIFECYCLE_PATHS.changePassword : PROTOTYPE_LIFECYCLE_PATHS.setPassword;
    return instance.handler(
      mutationRequest(path, cookie, {
        newPassword,
        ...(kind === 'change' ? { currentPassword: originalPassword } : {}),
      }),
    );
  }

  async function passwordMatches(userId: string, password: string) {
    const [credential] = await environment.database
      .select()
      .from(environment.schema.account)
      .where(
        and(eq(environment.schema.account.userId, userId), eq(environment.schema.account.providerId, 'credential')),
      );
    return credential?.password ? compare(password, credential.password) : false;
  }

  async function bindOldReset(identity: { userId: string; email: string }) {
    const token = randomUUID();
    const record = {
      identifier: `password-reset:${identity.email}`,
      token: createHash('sha256').update(token).digest('hex'),
      expires: new Date(cutoverAt.getTime() + 20 * 60 * 1000),
    };
    const snapshot: PrototypeLegacyRecoverySnapshot = {
      users: [{ id: identity.userId, email: identity.email }],
      records: [record],
      ownership: [
        {
          identifier: record.identifier,
          storedToken: record.token,
          originalUserId: identity.userId,
          source: 'captured-at-issuance',
        },
      ],
    };
    expect(await bindPrototypeLegacyRecoveryLinks(environment.database, snapshot, cutoverAt)).toEqual({
      bound: 1,
      rejected: 0,
    });
    return { token, snapshot };
  }

  async function partnerTokens(identity: { cookie: string }) {
    const redirectUri = `https://client.example.test/lifecycle/${randomUUID()}`;
    const client = await authority.api.adminCreateOAuthClient({
      headers: new Headers({ cookie: identity.cookie }),
      body: {
        client_name: 'Lifecycle partner fixture',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'profile:read offline_access',
        require_pkce: true,
        skip_consent: true,
      },
    });
    await environment.database
      .insert(environment.schema.oauthClientResource)
      .values({ id: randomUUID(), clientId: client.client_id, resourceId: PROTOTYPE_RESOURCE, createdAt: new Date() });
    const verifier = randomBytes(32).toString('base64url');
    const authorization = new URL(`${PROTOTYPE_ISSUER}/oauth2/authorize`);
    authorization.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'profile:read offline_access',
      state: randomUUID(),
      resource: PROTOTYPE_RESOURCE,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    const handler = createSerializedPrototypeOAuthHandler(environment.database);
    const authorized = await handler.handler(new Request(authorization, { headers: { cookie: identity.cookie } }));
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code');
    expect(code).toBeTruthy();
    const clientCredentials = { client_id: client.client_id, client_secret: client.client_secret! };
    async function post(path: string, fields: Record<string, string>) {
      const result = await handler.handler(
        new Request(`${PROTOTYPE_ISSUER}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ...clientCredentials, ...fields }),
        }),
      );
      return { response: result, body: (await result.json()) as Record<string, unknown> };
    }
    const issued = await post('/oauth2/token', {
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    expect(issued.response.status).toBe(200);
    const accessToken = issued.body.access_token as string;
    const refreshToken = issued.body.refresh_token as string;
    expect((await post('/oauth2/introspect', { token: accessToken })).body.active).toBe(true);
    return { accessToken, refreshToken, post };
  }

  it('records that stock change-password accepts unknown age and never invokes the password-reset hook', async () => {
    const identity = await fixture();
    await environment.database
      .update(environment.schema.session)
      .set({ createdAt: new Date(0), originalAuthenticatedAt: null })
      .where(eq(environment.schema.session.id, identity.sessionId));
    let resetHookCalls = 0;
    const stock = environment.createAuthority({
      emailAndPassword: {
        ...PROTOTYPE_CONFIGURATION.emailAndPassword,
        async onPasswordReset() {
          resetHookCalls += 1;
        },
      },
    });
    const changed = await stock.api.changePassword({
      headers: new Headers({ cookie: identity.cookie }),
      body: { currentPassword: originalPassword, newPassword: nextPassword, revokeOtherSessions: false },
      asResponse: true,
    });
    expect(changed.status).toBe(200);
    expect(await passwordMatches(identity.userId, nextPassword)).toBe(true);
    expect(resetHookCalls).toBe(0);
    expect(await stock.api.getSession({ headers: new Headers({ cookie: identity.cookie }) })).not.toBeNull();
  });

  it('records that stock set-password is server-only and accepts unknown age without calling the reset hook', async () => {
    const identity = await fixture(false);
    await environment.database
      .update(environment.schema.session)
      .set({ createdAt: new Date(0), originalAuthenticatedAt: null })
      .where(eq(environment.schema.session.id, identity.sessionId));
    let resetHookCalls = 0;
    const stock = environment.createAuthority({
      emailAndPassword: {
        ...PROTOTYPE_CONFIGURATION.emailAndPassword,
        async onPasswordReset() {
          resetHookCalls += 1;
        },
      },
    });
    expect(
      (await stock.handler(mutationRequest('/set-password', identity.cookie, { newPassword: nextPassword }))).status,
    ).toBe(404);
    expect(
      (
        await stock.api.setPassword({
          headers: new Headers({ cookie: identity.cookie }),
          body: { newPassword: nextPassword },
          asResponse: true,
        })
      ).status,
    ).toBe(200);
    expect(await passwordMatches(identity.userId, nextPassword)).toBe(true);
    expect(resetHookCalls).toBe(0);
  });

  it('changes exact password bytes and replaces only the authenticated requester session', async () => {
    const identity = await fixture();
    const native = createPrototypeNativeFacade(environment.database, nativeKey);
    const nativePair = await native.credentials(identity.email, originalPassword);
    const unrelated = await fixture();
    const completed = await mutate('change', identity.cookie);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({ status: true, requiresSignIn: false });
    expect(completed.headers.get('cache-control')).toBe('no-store');
    const replacementCookie = cookieHeader(completed);
    expect(replacementCookie).not.toBe('');
    expect(replacementCookie).not.toBe(identity.cookie);
    expect(await passwordMatches(identity.userId, originalPassword)).toBe(false);
    expect(await passwordMatches(identity.userId, nextPassword)).toBe(true);
    expect(await passwordMatches(identity.userId, nextPassword.trim())).toBe(false);
    expect(await authority.api.getSession({ headers: new Headers({ cookie: identity.cookie }) })).toBeNull();
    const replacement = await authority.api.getSession({ headers: new Headers({ cookie: replacementCookie }) });
    expect(replacement?.user.id).toBe(identity.userId);
    expect(replacement?.session.id).not.toBe(identity.sessionId);
    expect(await native.validateAccessToken(nativePair.jwt)).toBeNull();
    await expect(native.refresh(nativePair.refreshToken)).rejects.toThrow();
    expect((await authority.api.getSession({ headers: new Headers({ cookie: unrelated.cookie }) }))?.user.id).toBe(
      unrelated.userId,
    );
    const restarted = environment.createAuthority();
    expect(
      (await restarted.api.signInEmail({ body: { email: identity.email, password: nextPassword }, asResponse: true }))
        .status,
    ).toBe(200);
    expect(
      (
        await restarted.api.signInEmail({
          body: { email: identity.email, password: originalPassword },
          asResponse: true,
        })
      ).status,
    ).toBe(401);
  });

  it('adds a password to a fresh social account without promoting its verification state or changing provider subject', async () => {
    const identity = await fixture(false);
    const completed = await mutate('set', identity.cookie);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({ status: true, requiresSignIn: false });
    expect(await passwordMatches(identity.userId, nextPassword)).toBe(true);
    const [stored] = await environment.database
      .select()
      .from(environment.schema.user)
      .where(eq(environment.schema.user.id, identity.userId));
    expect(stored.emailVerified).toBe(false);
    expect(stored.legacyEmailVerifiedAt).toBeNull();
    const credentials = await environment.database
      .select()
      .from(environment.schema.account)
      .where(
        and(
          eq(environment.schema.account.userId, identity.userId),
          eq(environment.schema.account.providerId, 'credential'),
        ),
      );
    expect(credentials).toHaveLength(1);
    expect(credentials[0].accountId).toBe(identity.userId);
    expect(credentials[0].password).toMatch(/^\$2[aby]\$12\$/);
    const [provider] = await environment.database
      .select()
      .from(environment.schema.account)
      .where(
        and(
          eq(environment.schema.account.userId, identity.userId),
          eq(environment.schema.account.providerId, 'google'),
        ),
      );
    expect(provider.accountId).toBe(identity.subject);
    expect(await authority.api.getSession({ headers: new Headers({ cookie: identity.cookie }) })).toBeNull();
    expect(
      (await authority.api.getSession({ headers: new Headers({ cookie: cookieHeader(completed) }) }))?.user.id,
    ).toBe(identity.userId);
  });

  it.each([
    ['change', 'old'],
    ['change', 'unknown'],
    ['set', 'old'],
    ['set', 'unknown'],
  ] as const)('rejects %s-password for %s authentication age before changing credentials', async (kind, age) => {
    const identity = await fixture(kind === 'change');
    await environment.database
      .update(environment.schema.session)
      .set({
        createdAt: age === 'unknown' ? new Date(0) : new Date(Date.now() - 10 * 60 * 1000),
        originalAuthenticatedAt: null,
      })
      .where(eq(environment.schema.session.id, identity.sessionId));
    const completed = await mutate(kind, identity.cookie);
    expect(completed.status).toBe(403);
    expect(await completed.json()).toMatchObject({ code: 'SESSION_NOT_FRESH' });
    expect(await passwordMatches(identity.userId, nextPassword)).toBe(false);
    expect(await passwordMatches(identity.userId, originalPassword)).toBe(kind === 'change');
    expect(await authority.api.getSession({ headers: new Headers({ cookie: identity.cookie }) })).not.toBeNull();
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, identity.userId)),
    ).toEqual([]);
  });

  it('rejects unauthenticated or cross-origin credential mutations', async () => {
    const identity = await fixture();
    const handler = createPrototypeLifecycleMutations(environment.database);
    expect((await mutate('change', '', nextPassword, handler)).status).toBe(401);
    const untrusted = mutationRequest(PROTOTYPE_LIFECYCLE_PATHS.changePassword, identity.cookie, {
      currentPassword: originalPassword,
      newPassword: nextPassword,
    });
    untrusted.headers.set('origin', 'https://attacker.example');
    expect((await handler.handler(untrusted)).status).toBe(403);
    expect(await passwordMatches(identity.userId, originalPassword)).toBe(true);
  });

  it('keeps freshness and origin protections enabled when constructing a fault-injection authority', async () => {
    const identity = await fixture();
    await environment.database
      .update(environment.schema.session)
      .set({ createdAt: new Date(0) })
      .where(eq(environment.schema.session.id, identity.sessionId));
    const handler = createPrototypeLifecycleMutations(environment.database, {
      authority: { session: { freshAge: 0 }, advanced: { disableOriginCheck: true, disableCSRFCheck: true } },
    });
    expect((await mutate('change', identity.cookie, nextPassword, handler)).status).toBe(403);
    const untrusted = mutationRequest(PROTOTYPE_LIFECYCLE_PATHS.changePassword, identity.cookie, {
      currentPassword: originalPassword,
      newPassword: nextPassword,
    });
    untrusted.headers.set('origin', 'https://attacker.example');
    const rejected = await handler.handler(untrusted);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ code: 'INVALID_ORIGIN' });
    expect(await passwordMatches(identity.userId, originalPassword)).toBe(true);
  });

  it('keeps authority validation errors free of revocation side effects', async () => {
    const identity = await fixture();
    const handler = createPrototypeLifecycleMutations(environment.database);
    const wrongPassword = await handler.handler(
      mutationRequest(PROTOTYPE_LIFECYCLE_PATHS.changePassword, identity.cookie, {
        currentPassword: 'wrong-password',
        newPassword: nextPassword,
      }),
    );
    expect(wrongPassword.status).toBe(400);
    expect(await wrongPassword.json()).toMatchObject({ code: 'INVALID_PASSWORD' });
    expect((await mutate('set', identity.cookie, nextPassword, handler)).status).toBe(400);
    expect((await mutate('change', identity.cookie, 'short', handler)).status).toBe(400);
    expect(await passwordMatches(identity.userId, originalPassword)).toBe(true);
    expect(await authority.api.getSession({ headers: new Headers({ cookie: identity.cookie }) })).not.toBeNull();
  });

  it.each(['change', 'set'] as const)('commits only one of two concurrent %s-password mutations', async (kind) => {
    const identity = await fixture(kind === 'change');
    const first = createPrototypeLifecycleMutations(environment.database);
    const second = createPrototypeLifecycleMutations(environment.database);
    const candidates = ['first-concurrent-password', 'second-concurrent-password'];
    const results = await Promise.all([
      mutate(kind, identity.cookie, candidates[0], first),
      mutate(kind, identity.cookie, candidates[1], second),
    ]);
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.filter((result) => result.status === 401)).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === 200);
    expect(await passwordMatches(identity.userId, candidates[winner])).toBe(true);
    expect(await passwordMatches(identity.userId, candidates[1 - winner])).toBe(false);
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, identity.userId)),
    ).toHaveLength(1);
    expect(
      await environment.database
        .select()
        .from(environment.schema.account)
        .where(
          and(
            eq(environment.schema.account.userId, identity.userId),
            eq(environment.schema.account.providerId, 'credential'),
          ),
        ),
    ).toHaveLength(1);
  });

  it('revokes any native refresh-race descendant when the password change commits', async () => {
    const identity = await fixture();
    const native = createPrototypeNativeFacade(environment.database, nativeKey);
    const original = await native.credentials(identity.email, originalPassword);
    const [changing, refreshing] = await Promise.allSettled([
      mutate('change', identity.cookie),
      native.refresh(original.refreshToken),
    ]);
    expect(changing.status).toBe('fulfilled');
    if (changing.status === 'fulfilled') expect(changing.value.status).toBe(200);
    expect(await native.validateAccessToken(original.jwt)).toBeNull();
    if (refreshing.status === 'fulfilled') {
      expect(await native.validateAccessToken(refreshing.value.jwt)).toBeNull();
      await expect(native.refresh(refreshing.value.refreshToken)).rejects.toThrow();
    }
    expect(await passwordMatches(identity.userId, nextPassword)).toBe(true);
  });

  it('invalidates actual partner access/refresh families and leaves unrelated connections usable', async () => {
    const identity = await fixture();
    const unrelated = await fixture();
    const partner = await partnerTokens(identity);
    const unrelatedPartner = await partnerTokens(unrelated);
    expect((await mutate('change', identity.cookie)).status).toBe(200);
    expect((await partner.post('/oauth2/introspect', { token: partner.accessToken })).body.active).toBe(false);
    expect(
      (await partner.post('/oauth2/token', { grant_type: 'refresh_token', refresh_token: partner.refreshToken })).body
        .error,
    ).toBe('invalid_grant');
    expect(
      (await unrelatedPartner.post('/oauth2/introspect', { token: unrelatedPartner.accessToken })).body.active,
    ).toBe(true);
  });

  it('supersedes both legacy recovery links and newer canonical reset records without restoring old hashes', async () => {
    const identity = await fixture();
    const legacy = await bindOldReset(identity);
    let canonicalToken = '';
    const canonical = environment.createAuthority({
      emailAndPassword: {
        ...PROTOTYPE_CONFIGURATION.emailAndPassword,
        async sendResetPassword({ token }) {
          canonicalToken = token;
        },
      },
    });
    expect(
      (await canonical.api.requestPasswordReset({ body: { email: identity.email }, asResponse: true })).status,
    ).toBe(200);
    expect(canonicalToken).not.toBe('');
    expect((await mutate('change', identity.cookie)).status).toBe(200);
    const restartedLegacy = createPrototypeLegacyRecoveryFacade(environment.database, cutoverAt);
    await expect(
      restartedLegacy.resetPassword({
        email: identity.email,
        token: legacy.token,
        password: originalPassword,
        confirmPassword: originalPassword,
      }),
    ).rejects.toThrow();
    expect(await bindPrototypeLegacyRecoveryLinks(environment.database, legacy.snapshot, cutoverAt)).toEqual({
      bound: 0,
      rejected: 1,
    });
    expect(
      (
        await canonical.api.resetPassword({
          body: { token: canonicalToken, newPassword: originalPassword },
          asResponse: true,
        })
      ).status,
    ).toBe(400);
    expect(await passwordMatches(identity.userId, nextPassword)).toBe(true);
    expect(await passwordMatches(identity.userId, originalPassword)).toBe(false);
  });

  it('prevents an old signed native artifact from recreating a revoked canonical session after mutation', async () => {
    const identity = await fixture();
    const issuedAt = Math.floor(Date.now() / 1000) - 1;
    const legacyToken = await new SignJWT({ sub: identity.userId, authSessionId: `old-lifecycle-${identity.userId}` })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('boardsesh')
      .setAudience('boardsesh-mobile')
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3600)
      .sign(PROTOTYPE_LEGACY_KEY);
    const bridgeRequest = () =>
      new Request(`${PROTOTYPE_ISSUER}/prototype-legacy-bridge`, {
        method: 'POST',
        headers: { authorization: `Bearer ${legacyToken}`, origin: 'https://www.boardsesh.test' },
      });
    expect((await createPrototypeLegacyHandler(environment.database)(bridgeRequest())).status).toBe(200);
    expect((await mutate('change', identity.cookie)).status).toBe(200);
    expect((await createPrototypeLegacyHandler(environment.database)(bridgeRequest())).status).toBe(401);
    expect(await passwordMatches(identity.userId, nextPassword)).toBe(true);
  });

  it('keeps native continuation eligible without extending the original five-minute freshness window', async () => {
    const identity = await fixture();
    const authenticatedAt = new Date(Date.now() - 4 * 60 * 1000);
    await environment.database
      .update(environment.schema.session)
      .set({ createdAt: authenticatedAt, originalAuthenticatedAt: authenticatedAt })
      .where(eq(environment.schema.session.id, identity.sessionId));
    const native = createPrototypeNativeFacade(environment.database, nativeKey);
    const requesterOldPair = await native.issueForVerifiedSession(identity.userId, identity.sessionId);
    const completed = await mutate('change', identity.cookie);
    expect(completed.status).toBe(200);
    const replacementCookie = cookieHeader(completed);
    const replacement = await authority.api.getSession({ headers: new Headers({ cookie: replacementCookie }) });
    expect(replacement?.session.createdAt).toEqual(authenticatedAt);
    expect(await native.validateAccessToken(requesterOldPair.jwt)).toBeNull();
    await expect(native.refresh(requesterOldPair.refreshToken)).rejects.toThrow();
    const pair = await native.issueForVerifiedSession(identity.userId, replacement!.session.id);
    expect(decodeJwt(pair.jwt).auth_time).toBe(Math.floor(authenticatedAt.getTime() / 1000));
    expect(await native.validateAccessToken(pair.jwt)).toMatchObject({ userId: identity.userId });
    expect(
      (
        await authority.handler(
          new Request(`${PROTOTYPE_ISSUER}/list-sessions`, { headers: { cookie: replacementCookie } }),
        )
      ).status,
    ).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(authenticatedAt.getTime() + 5 * 60 * 1000 + 1000);
      const ordinary = await native.refresh(pair.refreshToken);
      expect(await native.validateAccessToken(ordinary.jwt)).toMatchObject({ userId: identity.userId });
      expect(decodeJwt(ordinary.jwt).auth_time).toBe(Math.floor(authenticatedAt.getTime() / 1000));
      const sensitive = await authority.handler(
        new Request(`${PROTOTYPE_ISSUER}/list-sessions`, { headers: { cookie: replacementCookie } }),
      );
      expect(sensitive.status).toBe(403);
      expect(await sensitive.json()).toMatchObject({ code: 'SESSION_NOT_FRESH' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('advances generation for two password changes at the same millisecond while preserving authentication age', async () => {
    const identity = await fixture();
    const frozenTime = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(frozenTime);
      const first = await mutate('change', identity.cookie);
      expect(first.status).toBe(200);
      const firstCookie = cookieHeader(first);
      const firstSession = await authority.api.getSession({ headers: new Headers({ cookie: firstCookie }) });
      const native = createPrototypeNativeFacade(environment.database, nativeKey);
      const firstPair = await native.issueForVerifiedSession(identity.userId, firstSession!.session.id);
      const [firstCutoff] = await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, identity.userId));
      const second = await createPrototypeLifecycleMutations(environment.database).handler(
        mutationRequest(PROTOTYPE_LIFECYCLE_PATHS.changePassword, firstCookie, {
          currentPassword: nextPassword,
          newPassword: 'second-same-millisecond-password',
        }),
      );
      expect(second.status).toBe(200);
      const secondSession = await authority.api.getSession({ headers: new Headers({ cookie: cookieHeader(second) }) });
      expect(secondSession?.session.createdAt).toEqual(firstSession?.session.createdAt);
      const [secondCutoff] = await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, identity.userId));
      expect(secondCutoff.revokedThrough).toEqual(firstCutoff.revokedThrough);
      expect(secondCutoff.generation).toBe(firstCutoff.generation + 1);
      expect(await native.validateAccessToken(firstPair.jwt)).toBeNull();
      await expect(native.refresh(firstPair.refreshToken)).rejects.toThrow();
      expect(await authority.api.getSession({ headers: new Headers({ cookie: firstCookie }) })).toBeNull();
      const secondPair = await native.issueForVerifiedSession(identity.userId, secondSession!.session.id);
      expect(await native.validateAccessToken(secondPair.jwt)).toMatchObject({ userId: identity.userId });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['change', 'set'] as const)(
    'forgotten-password reset revokes the requester continuation created by %s-password',
    async (kind) => {
      const identity = await fixture(kind === 'change');
      const continued = await mutate(kind, identity.cookie);
      expect(continued.status).toBe(200);
      const replacementCookie = cookieHeader(continued);
      const replacement = await authority.api.getSession({ headers: new Headers({ cookie: replacementCookie }) });
      expect(replacement?.user.id).toBe(identity.userId);
      const native = createPrototypeNativeFacade(environment.database, nativeKey);
      const pair = await native.issueForVerifiedSession(identity.userId, replacement!.session.id);
      let recoveryToken = '';
      const recoveryAuthority = environment.createAuthority({
        emailAndPassword: {
          ...PROTOTYPE_CONFIGURATION.emailAndPassword,
          async sendResetPassword({ token }) {
            recoveryToken = token;
          },
        },
      });
      expect(
        (await recoveryAuthority.api.requestPasswordReset({ body: { email: identity.email }, asResponse: true }))
          .status,
      ).toBe(200);
      expect(recoveryToken).not.toBe('');
      const reset = await createPrototypeLegacyHandler(environment.database)(
        new Request(`${PROTOTYPE_ISSUER}/reset-password`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://www.boardsesh.test' },
          body: JSON.stringify({ token: recoveryToken, newPassword: 'forgotten-password-recovery-value' }),
        }),
      );
      expect(reset.status).toBe(200);
      expect(reset.headers.getSetCookie()).toEqual([]);
      expect(await authority.api.getSession({ headers: new Headers({ cookie: replacementCookie }) })).toBeNull();
      expect(await native.validateAccessToken(pair.jwt)).toBeNull();
      await expect(native.refresh(pair.refreshToken)).rejects.toThrow();
      expect(
        await environment.database
          .select()
          .from(environment.schema.session)
          .where(eq(environment.schema.session.userId, identity.userId)),
      ).toEqual([]);
      expect(await passwordMatches(identity.userId, 'forgotten-password-recovery-value')).toBe(true);
      expect(await passwordMatches(identity.userId, nextPassword)).toBe(false);
    },
  );

  it('binds continuation to current generation even when a preserved cutoff timestamp is ahead of the clock', async () => {
    const identity = await fixture();
    const futureCutoff = new Date(Date.now() + 60 * 60 * 1000);
    await environment.database
      .insert(environment.schema.prototypeUserCutoff)
      .values({ userId: identity.userId, revokedThrough: futureCutoff, generation: 7 });
    const freshLogin = await authority.api.signInEmail({
      headers: new Headers({ origin: 'https://www.boardsesh.test' }),
      body: { email: identity.email, password: originalPassword },
      asResponse: true,
    });
    expect(freshLogin.status).toBe(200);
    const completed = await mutate('change', cookieHeader(freshLogin));
    expect(completed.status).toBe(200);
    const replacement = await authority.api.getSession({ headers: new Headers({ cookie: cookieHeader(completed) }) });
    const [stored] = await environment.database
      .select()
      .from(environment.schema.session)
      .where(eq(environment.schema.session.id, replacement!.session.id));
    const [cutoff] = await environment.database
      .select()
      .from(environment.schema.prototypeUserCutoff)
      .where(eq(environment.schema.prototypeUserCutoff.userId, identity.userId));
    expect(stored.createdAt.getTime()).toBeLessThan(cutoff.revokedThrough.getTime());
    expect(cutoff.revokedThrough).toEqual(futureCutoff);
    expect(stored.revocationGeneration).toBe(8);
    expect(cutoff.generation).toBe(8);
    const native = createPrototypeNativeFacade(environment.database, nativeKey);
    const pair = await native.issueForVerifiedSession(identity.userId, stored.id);
    expect(await native.validateAccessToken(pair.jwt)).toMatchObject({ userId: identity.userId });
  });

  it('rejects an obsolete generation before credential mutation even when its cookie and authentication age remain valid', async () => {
    const identity = await fixture();
    await environment.database
      .insert(environment.schema.prototypeUserCutoff)
      .values({ userId: identity.userId, revokedThrough: new Date(), generation: 1 });
    const completed = await mutate('change', identity.cookie);
    expect(completed.status).toBe(401);
    expect(await passwordMatches(identity.userId, originalPassword)).toBe(true);
    expect(await passwordMatches(identity.userId, nextPassword)).toBe(false);
    const [cutoff] = await environment.database
      .select()
      .from(environment.schema.prototypeUserCutoff)
      .where(eq(environment.schema.prototypeUserCutoff.userId, identity.userId));
    expect(cutoff.generation).toBe(1);
  });

  it.each([
    'replacement-creation',
    'post-cookie',
    'late-policy-denial',
    'plugin-api-error',
    'global-api-error',
    'plugin-response',
    'global-response',
  ] as const)('rolls back %s failure without publishing an uncommitted replacement', async (failurePoint) => {
    const identity = await fixture();
    let observedPendingReplacement = false;
    let options: Parameters<typeof createPrototypeLifecycleMutations>[1];
    if (failurePoint === 'replacement-creation') {
      options = {
        authority: {
          databaseHooks: {
            session: {
              create: {
                async before() {
                  return false;
                },
              },
            },
          },
        },
      };
    } else if (failurePoint === 'post-cookie') {
      options = {
        authority: {
          plugins: [
            {
              id: 'synthetic-post-cookie-failure',
              hooks: {
                after: [
                  {
                    matcher: (context) => context.path === PROTOTYPE_LIFECYCLE_PATHS.changePassword,
                    handler: createAuthMiddleware(async (context) => {
                      observedPendingReplacement = Boolean(context.context.newSession?.session);
                      throw new Error('Synthetic post-cookie failure');
                    }),
                  },
                ],
              },
            },
          ],
        },
      };
    } else if (failurePoint === 'late-policy-denial') {
      options = {
        authority: {
          databaseHooks: {
            account: {
              update: {
                async after() {
                  throw new APIError('FORBIDDEN', { code: 'SYNTHETIC_LATE_DENIAL' });
                },
              },
            },
          },
        },
      };
    } else {
      const after = createAuthMiddleware(async (context) => {
        if (context.path !== PROTOTYPE_LIFECYCLE_PATHS.changePassword) return;
        observedPendingReplacement = Boolean(context.context.newSession?.session);
        if (failurePoint.endsWith('response'))
          return Response.json({ code: 'POST_COOKIE_POLICY_DENIED' }, { status: 403 });
        throw new APIError('FORBIDDEN', { code: 'POST_COOKIE_POLICY_DENIED' });
      });
      options = {
        authority: failurePoint.startsWith('global')
          ? { hooks: { after } }
          : { plugins: [{ id: 'late-password-policy', hooks: { after: [{ matcher: () => true, handler: after }] } }] },
      };
    }
    const completed = await mutate(
      'change',
      identity.cookie,
      nextPassword,
      createPrototypeLifecycleMutations(environment.database, options),
    );
    expect(completed.status).toBe(['replacement-creation', 'post-cookie'].includes(failurePoint) ? 500 : 403);
    if (failurePoint !== 'replacement-creation' && failurePoint !== 'late-policy-denial')
      expect(observedPendingReplacement).toBe(true);
    expect(completed.headers.getSetCookie()).toEqual([]);
    expect(await passwordMatches(identity.userId, originalPassword)).toBe(true);
    expect(await passwordMatches(identity.userId, nextPassword)).toBe(false);
    expect((await authority.api.getSession({ headers: new Headers({ cookie: identity.cookie }) }))?.session.id).toBe(
      identity.sessionId,
    );
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, identity.userId)),
    ).toHaveLength(1);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, identity.userId)),
    ).toEqual([]);
  });

  it.each(['credential-write', 'revocation'] as const)(
    'rolls back a failure after %s without publishing cookies or restoring stale credentials on restart',
    async (failurePoint) => {
      const identity = await fixture();
      const native = createPrototypeNativeFacade(environment.database, nativeKey);
      const original = await native.credentials(identity.email, originalPassword);
      const failing = createPrototypeLifecycleMutations(
        environment.database,
        failurePoint === 'revocation'
          ? {
              async afterMutation() {
                throw new Error('Synthetic lifecycle revocation publication failure');
              },
            }
          : {
              authority: {
                databaseHooks: {
                  account: {
                    update: {
                      async after() {
                        throw new Error('Synthetic lifecycle credential write failure');
                      },
                    },
                  },
                },
              },
            },
      );
      const failed = await mutate('change', identity.cookie, nextPassword, failing);
      expect(failed.status).toBe(500);
      expect(failed.headers.getSetCookie()).toEqual([]);
      expect(await passwordMatches(identity.userId, originalPassword)).toBe(true);
      expect(await passwordMatches(identity.userId, nextPassword)).toBe(false);
      expect(await native.validateAccessToken(original.jwt)).not.toBeNull();
      expect(await authority.api.getSession({ headers: new Headers({ cookie: identity.cookie }) })).not.toBeNull();
      expect(
        await environment.database
          .select()
          .from(environment.schema.prototypeUserCutoff)
          .where(eq(environment.schema.prototypeUserCutoff.userId, identity.userId)),
      ).toEqual([]);
      expect((await mutate('change', identity.cookie)).status).toBe(200);
      expect(await passwordMatches(identity.userId, nextPassword)).toBe(true);
      expect(await passwordMatches(identity.userId, originalPassword)).toBe(false);
      expect(await native.validateAccessToken(original.jwt)).toBeNull();
    },
  );
});
