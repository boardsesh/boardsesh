import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { and, eq, sql } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { APIError, createAuthEndpoint, createAuthMiddleware, freshSessionMiddleware } from 'better-auth/api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { createPrototypeAuthority } from '../authority';
import {
  createPrototypeCredentialContinuation,
  readPrototypeCredentialSourceForIdentity,
} from '../credential-continuation';
import {
  createIdentityPrototypeOptions,
  PROTOTYPE_GOOGLE_AUDIENCES,
  PROTOTYPE_APPLE_AUDIENCES,
} from '../identity-providers';
import {
  createFacebookPrototypeOptions,
  PROTOTYPE_FACEBOOK_CLIENT_ID,
  PROTOTYPE_FACEBOOK_CLIENT_SECRET,
  PROTOTYPE_FACEBOOK_CALLBACK_URL,
} from '../facebook-providers';
import { planPrototypeIdentityImport } from '../identity-fixtures';
import {
  createPrototypeProviderLinkLifecycle,
  PROTOTYPE_PROVIDER_LINK_PATHS,
  PROTOTYPE_PROVIDER_LINK_CALLBACK,
  PROTOTYPE_EXPLICIT_PROVIDER_LINK_POLICY,
} from '../provider-link-lifecycle';
import { createPrototypeLifecycleMutations, PROTOTYPE_LIFECYCLE_PATHS } from '../lifecycle-mutations';
import { createPrototypeNativeFacade } from '../identity-native-facade';
import { createPrototypeLegacyHandler } from '../legacy-bridge';
import { PROTOTYPE_ISSUER, PROTOTYPE_RESOURCE } from '../oauth-options';
import { createSerializedPrototypeOAuthHandler, disconnectPrototypeOAuthConnection } from '../oauth-transaction';

const password = 'provider-link-original-password';
const providerKeyId = 'provider-link-fixture-key';
const nativeKey = new TextEncoder().encode('disposable-provider-link-native-key');
type Environment = Awaited<ReturnType<typeof createPrototypeEnvironment>>;
type LinkHandler = ReturnType<typeof createPrototypeProviderLinkLifecycle>;

function cookies(response: Response, name?: string): string {
  return response.headers
    .getSetCookie()
    .filter((header) => !name || header.includes(name))
    .map((header) => header.split(';')[0])
    .join('; ');
}

describe('explicit provider link/unlink through one authority and shared continuation', () => {
  let environment: Environment;
  let authority: Environment['auth'];
  let providerOptions: Parameters<typeof createPrototypeProviderLinkLifecycle>[1]['authority'];
  let passwordHash: string;
  let signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let wrongKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
  let primary: LinkHandler;
  let secondary: LinkHandler;
  const facebookCodes = new Map<string, { subject: string; email: string; appId?: string; tokenSubject?: string }>();
  const facebookTokens = new Map<string, { subject: string; email: string; appId?: string; tokenSubject?: string }>();
  const appleCodes = new Map<string, string>();
  const outbound: string[] = [];

  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    const generated = await generateKeyPair('RS256');
    signingKey = generated.privateKey;
    publicJwk = await exportJWK(generated.publicKey);
    wrongKey = (await generateKeyPair('RS256')).privateKey;
    passwordHash = await hash(password, 4);
    async function existing(provider: 'apple' | 'facebook', subject: string) {
      const accounts = await environment.database
        .select({
          email: environment.schema.user.email,
          name: environment.schema.user.name,
          emailVerified: environment.schema.user.emailVerified,
        })
        .from(environment.schema.account)
        .innerJoin(environment.schema.user, eq(environment.schema.user.id, environment.schema.account.userId))
        .where(
          and(eq(environment.schema.account.providerId, provider), eq(environment.schema.account.accountId, subject)),
        );
      return accounts.length === 1 ? accounts[0] : null;
    }
    const native = createIdentityPrototypeOptions((subject) => existing('apple', subject));
    const facebook = createFacebookPrototypeOptions((subject) => existing('facebook', subject));
    providerOptions = { ...native, socialProviders: { ...native.socialProviders, ...facebook.socialProviders } };
    authority = environment.createAuthority(providerOptions);
    primary = createPrototypeProviderLinkLifecycle(environment.database, { authority: providerOptions });
    secondary = createPrototypeProviderLinkLifecycle(environment.database, { authority: providerOptions });
  });
  afterAll(async () => environment?.close());

  beforeEach(() => {
    outbound.length = 0;
    facebookCodes.clear();
    facebookTokens.clear();
    appleCodes.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        outbound.push(`${url.origin}${url.pathname}`);
        if (
          url.toString() === 'https://www.googleapis.com/oauth2/v3/certs' ||
          url.toString() === 'https://appleid.apple.com/auth/keys'
        ) {
          return Response.json({ keys: [{ ...publicJwk, kid: providerKeyId, alg: 'RS256', use: 'sig' }] });
        }
        if (url.toString() === 'https://appleid.apple.com/auth/token') {
          const form = new URLSearchParams(await request.text());
          expect(form.get('redirect_uri')).toBe(`${PROTOTYPE_ISSUER}/callback/apple`);
          expect(form.get('grant_type')).toBe('authorization_code');
          expect(form.get('client_id')).toBe(PROTOTYPE_APPLE_AUDIENCES[0]);
          const code = form.get('code') ?? '';
          const idToken = appleCodes.get(code);
          if (!idToken) return Response.json({ error: 'invalid_grant' }, { status: 400 });
          appleCodes.delete(code);
          return Response.json({
            access_token: `fixture-apple-${randomUUID()}`,
            token_type: 'Bearer',
            expires_in: 3600,
            id_token: idToken,
          });
        }
        if (url.origin !== 'https://graph.facebook.com')
          throw new Error('Unexpected provider-link fixture network request');
        if (url.pathname === '/v24.0/oauth/access_token') {
          const form = new URLSearchParams(await request.text());
          expect(form.get('redirect_uri')).toBe(PROTOTYPE_FACEBOOK_CALLBACK_URL);
          expect(form.get('client_id')).toBe(PROTOTYPE_FACEBOOK_CLIENT_ID);
          expect(form.get('client_secret')).toBe(PROTOTYPE_FACEBOOK_CLIENT_SECRET);
          const code = form.get('code') ?? '';
          const fixture = facebookCodes.get(code);
          if (!fixture)
            return Response.json({ error: { message: 'Invalid or consumed fixture code' } }, { status: 400 });
          facebookCodes.delete(code);
          const accessToken = `provider-link-facebook-${randomUUID()}`;
          facebookTokens.set(accessToken, fixture);
          return Response.json({ access_token: accessToken, token_type: 'bearer', expires_in: 3600 });
        }
        if (url.pathname === '/debug_token') {
          const fixture = facebookTokens.get(url.searchParams.get('input_token') ?? '');
          return Response.json({
            data: fixture
              ? {
                  is_valid: true,
                  app_id: fixture.appId ?? PROTOTYPE_FACEBOOK_CLIENT_ID,
                  user_id: fixture.tokenSubject ?? fixture.subject,
                }
              : { is_valid: false },
          });
        }
        if (url.pathname === '/me') {
          const bearer = request.headers.get('authorization')?.slice(7) ?? '';
          const fixture = facebookTokens.get(bearer);
          return fixture
            ? Response.json({
                id: fixture.subject,
                email: fixture.email,
                name: 'Verified provider fixture',
                picture: {
                  data: { url: 'https://images.example.test/avatar', width: 100, height: 100, is_silhouette: false },
                },
              })
            : Response.json({ error: { message: 'Unknown token' } }, { status: 400 });
        }
        throw new Error('Unexpected Facebook fixture path');
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function token(provider: 'google' | 'apple', subject: string, claims: JWTPayload = {}, key = signingKey) {
    return new SignJWT({
      sub: subject,
      iss: provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com',
      aud: provider === 'google' ? PROTOTYPE_GOOGLE_AUDIENCES[0] : PROTOTYPE_APPLE_AUDIENCES[0],
      email: `${subject}@provider.example.test`,
      email_verified: true,
      name: 'Provider fixture',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: providerKeyId })
      .sign(key);
  }

  async function fixture(options: { credential?: boolean; provider?: 'google' | 'apple'; verified?: boolean } = {}) {
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    const subject = `existing-${userId}`;
    const planned = planPrototypeIdentityImport([
      {
        id: userId,
        email,
        name: 'Local unchanged profile',
        image: null,
        emailVerifiedAt: options.verified ? new Date('2024-01-01Z') : null,
        createdAt: new Date('2023-01-01Z'),
        updatedAt: new Date(),
        passwordHash: options.credential === false ? null : passwordHash,
        providers: options.provider ? [{ provider: options.provider, subject }] : [],
      },
    ]);
    await environment.database.transaction(async (transaction) => {
      await transaction.insert(environment.schema.user).values(planned.users);
      if (planned.accounts.length) await transaction.insert(environment.schema.account).values(planned.accounts);
    });
    const signedIn =
      options.credential === false
        ? await authority.api.signInSocial({
            body: {
              provider: options.provider!,
              idToken: {
                token: await token(options.provider!, subject, { email, email_verified: options.verified ?? false }),
              },
            },
            asResponse: true,
          })
        : await authority.api.signInEmail({ body: { email, password }, asResponse: true });
    expect(signedIn.status).toBe(200);
    const cookie = cookies(signedIn, 'better-auth.session_token=');
    const current = await authority.api.getSession({ headers: new Headers({ cookie }) });
    if (!current) throw new Error('Missing fixture session');
    return {
      userId,
      email,
      subject,
      cookie,
      sessionId: current.session.id,
      createdAt: current.session.createdAt,
      expiresAt: current.session.expiresAt,
    };
  }

  function request(path: string, cookie: string, payload: unknown, origin = 'https://www.boardsesh.test') {
    return new Request(`${PROTOTYPE_ISSUER}${path}`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
  function link(
    identity: { cookie: string },
    provider: 'google' | 'apple',
    idToken: { token: string; nonce?: string },
    handler = primary,
  ) {
    return handler.handler(request(PROTOTYPE_PROVIDER_LINK_PATHS.link, identity.cookie, { provider, idToken }));
  }
  function unlink(identity: { cookie: string }, accountId: string, handler = primary) {
    return handler.handler(request(PROTOTYPE_PROVIDER_LINK_PATHS.unlink, identity.cookie, { accountId }));
  }
  async function accounts(userId: string) {
    return environment.database
      .select()
      .from(environment.schema.account)
      .where(eq(environment.schema.account.userId, userId));
  }
  async function session(cookie: string) {
    return authority.api.getSession({ headers: new Headers({ cookie }) });
  }
  async function assertContinuation(identity: Awaited<ReturnType<typeof fixture>>, response: Response) {
    const replacement = cookies(response, 'better-auth.session_token=');
    expect(replacement).not.toBe('');
    expect(replacement).not.toBe(identity.cookie);
    expect(await session(identity.cookie)).toBeNull();
    const current = await session(replacement);
    expect(current?.user.id).toBe(identity.userId);
    expect(current?.session.createdAt).toEqual(identity.createdAt);
    expect(current?.session.expiresAt).toEqual(identity.expiresAt);
    expect(current?.session.id).not.toBe(identity.sessionId);
    return { cookie: replacement, current };
  }

  it('links a verified Google subject with a different email without changing local identity or age', async () => {
    const identity = await fixture();
    const [before] = await environment.database
      .select()
      .from(environment.schema.user)
      .where(eq(environment.schema.user.id, identity.userId));
    const native = createPrototypeNativeFacade(environment.database, nativeKey, providerOptions);
    const oldNative = await native.credentials(identity.email, password);
    const subject = `new-google-${randomUUID()}`;
    const response = await link(identity, 'google', { token: await token('google', subject) });
    expect(response.status).toBe(200);
    await assertContinuation(identity, response);
    const [after] = await environment.database
      .select()
      .from(environment.schema.user)
      .where(eq(environment.schema.user.id, identity.userId));
    expect(after).toMatchObject({
      email: before.email,
      emailVerified: false,
      legacyEmailVerifiedAt: null,
      name: before.name,
      image: before.image,
    });
    expect(
      (await accounts(identity.userId)).some(
        (account) => account.providerId === 'google' && account.accountId === subject,
      ),
    ).toBe(true);
    expect(await native.validateAccessToken(oldNative.jwt)).toBeNull();
    await expect(native.refresh(oldNative.refreshToken)).rejects.toBeDefined();
  });

  it('links Apple only with the real provider nonce/signature checks', async () => {
    const identity = await fixture();
    const subject = `apple-new-${randomUUID()}`;
    const nonce = randomUUID();
    const response = await link(identity, 'apple', {
      token: await token('apple', subject, {
        nonce: createHash('sha256').update(nonce).digest('hex'),
        email_verified: 'true',
      }),
      nonce,
    });
    expect(response.status).toBe(200);
    await assertContinuation(identity, response);
    expect(
      (await accounts(identity.userId)).some(
        (account) => account.providerId === 'apple' && account.accountId === subject,
      ),
    ).toBe(true);
  });

  it('relinks a returning Apple subject without email using only its proven existing mapping', async () => {
    const identity = await fixture({ provider: 'apple' });
    const response = await link(identity, 'apple', {
      token: await token('apple', identity.subject, { email: undefined }),
    });
    expect(response.status).toBe(200);
    await assertContinuation(identity, response);
    expect((await accounts(identity.userId)).filter((account) => account.providerId === 'apple')).toHaveLength(1);
  });

  it.each([
    ['wrong audience', { aud: 'foreign-client' }],
    ['wrong issuer', { iss: 'https://attacker.example' }],
    ['expired', { exp: 1 }],
  ] as const)('rejects a verified-format Google token with %s', async (_reason, claims) => {
    const identity = await fixture();
    const response = await link(identity, 'google', {
      token: await token('google', `rejected-${randomUUID()}`, claims),
    });
    expect(response.status).toBe(401);
    expect(cookies(response)).toBe('');
    expect(await accounts(identity.userId)).toHaveLength(1);
    expect((await session(identity.cookie))?.user.id).toBe(identity.userId);
  });

  it('rejects a forged signature and a mismatched Apple nonce before any link', async () => {
    const identity = await fixture();
    const forged = await link(identity, 'google', { token: await token('google', randomUUID(), {}, wrongKey) });
    expect(forged.status).toBe(401);
    const nonce = await link(identity, 'apple', {
      token: await token('apple', randomUUID(), { nonce: 'wrong' }),
      nonce: 'expected',
    });
    expect(nonce.status).toBe(401);
    expect(await accounts(identity.userId)).toHaveLength(1);
  });

  it('does not invent an email for an unknown Apple provider subject', async () => {
    const identity = await fixture();
    const response = await link(identity, 'apple', { token: await token('apple', randomUUID(), { email: undefined }) });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'USER_EMAIL_NOT_FOUND' });
    expect(await accounts(identity.userId)).toHaveLength(1);
  });

  it('rejects a subject already owned by another user without merging or reassigning either account', async () => {
    const owner = await fixture({ provider: 'google' });
    const actor = await fixture();
    const response = await link(actor, 'google', {
      token: await token('google', owner.subject, { email: actor.email }),
    });
    expect(response.status).toBe(409);
    expect((await accounts(owner.userId)).find((account) => account.providerId === 'google')?.accountId).toBe(
      owner.subject,
    );
    expect(await accounts(actor.userId)).toHaveLength(1);
    expect((await session(actor.cookie))?.user.id).toBe(actor.userId);
  });

  it('rejects an ambiguous duplicate provider subject even when one row belongs to the actor', async () => {
    const actor = await fixture({ provider: 'google' });
    const other = await fixture();
    await environment.database
      .insert(environment.schema.account)
      .values({ id: randomUUID(), providerId: 'google', accountId: actor.subject, userId: other.userId });
    const response = await link(actor, 'google', { token: await token('google', actor.subject) });
    expect(response.status).toBe(409);
    expect(cookies(response)).toBe('');
    expect((await accounts(actor.userId)).filter((account) => account.providerId === 'google')).toHaveLength(1);
    expect((await accounts(other.userId)).filter((account) => account.providerId === 'google')).toHaveLength(1);
  });

  it.each(['old', 'unknown', 'future', 'obsolete-generation'] as const)(
    'rejects %s source assurance before provider work',
    async (condition) => {
      const actor = await fixture();
      if (condition === 'obsolete-generation') {
        await environment.database
          .insert(environment.schema.prototypeUserCutoff)
          .values({ userId: actor.userId, revokedThrough: new Date(), generation: 1 });
      } else {
        await environment.database
          .update(environment.schema.session)
          .set(
            condition === 'old'
              ? { createdAt: new Date(Date.now() - 600_000) }
              : condition === 'unknown'
                ? { legacyLineageId: 'unknown-age', originalAuthenticatedAt: null }
                : { createdAt: new Date(Date.now() + 60_000) },
          )
          .where(eq(environment.schema.session.id, actor.sessionId));
      }
      const response = await link(actor, 'google', { token: await token('google', randomUUID()) });
      expect([401, 403]).toContain(response.status);
      expect(cookies(response)).toBe('');
      expect(outbound).toHaveLength(0);
      expect(await accounts(actor.userId)).toHaveLength(1);
    },
  );

  it('rejects an untrusted origin and a caller-supplied alternate actor', async () => {
    const actor = await fixture();
    const idToken = { token: await token('google', randomUUID()) };
    const origin = await primary.handler(
      request(
        PROTOTYPE_PROVIDER_LINK_PATHS.link,
        actor.cookie,
        { provider: 'google', idToken },
        'https://attacker.example',
      ),
    );
    expect(origin.status).toBe(403);
    const actorOverride = await primary.handler(
      request(PROTOTYPE_PROVIDER_LINK_PATHS.link, actor.cookie, { provider: 'google', idToken, userId: randomUUID() }),
    );
    expect(actorOverride.status).toBe(400);
    expect(await accounts(actor.userId)).toHaveLength(1);
  });

  it('the shared continuation rejects a different live session belonging to the same user', async () => {
    const actor = await fixture();
    const secondLogin = await authority.api.signInEmail({ body: { email: actor.email, password }, asResponse: true });
    const secondCookie = cookies(secondLogin, 'better-auth.session_token=');
    const firstIdentity = await authority.api.getSession({ headers: new Headers({ cookie: actor.cookie }) });
    const result = await environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 1)`);
      const firstSource = await readPrototypeCredentialSourceForIdentity(transaction, firstIdentity);
      const continuation = createPrototypeCredentialContinuation(transaction);
      const mismatched = createPrototypeAuthority(transaction, {
        databaseHooks: { session: { create: { before: continuation.beforeSessionCreate } } },
        plugins: [
          {
            id: 'same-user-source-mismatch-proof',
            endpoints: {
              prototypeWrongSource: createAuthEndpoint(
                '/prototype-wrong-credential-source',
                { method: 'POST', use: [freshSessionMiddleware] },
                async (context) => {
                  await continuation.replace(context, firstSource);
                  return context.json({ status: true });
                },
              ),
            },
          },
        ],
      });
      return mismatched.handler(request('/prototype-wrong-credential-source', secondCookie, {}));
    });
    expect(result.status).toBe(401);
    expect(cookies(result)).toBe('');
    expect((await session(actor.cookie))?.session.id).toBe(actor.sessionId);
    expect((await session(secondCookie))?.session.id).not.toBe(actor.sessionId);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, actor.userId)),
    ).toHaveLength(0);
  });

  it('unlinks a provider while keeping the valid password and a new same-age current-device session', async () => {
    const actor = await fixture({ provider: 'google' });
    const account = (await accounts(actor.userId)).find((candidate) => candidate.providerId === 'google')!;
    const response = await unlink(actor, account.id);
    expect(response.status).toBe(200);
    await assertContinuation(actor, response);
    const remaining = await accounts(actor.userId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].password).toBe(passwordHash);
  });

  it('rejects unlinking the last usable method despite null-password and unconfigured-provider rows', async () => {
    const actor = await fixture({ credential: false, provider: 'google' });
    const account = (await accounts(actor.userId))[0];
    await environment.database.insert(environment.schema.account).values([
      { id: randomUUID(), userId: actor.userId, providerId: 'credential', accountId: actor.userId, password: null },
      { id: randomUUID(), userId: actor.userId, providerId: 'not-configured', accountId: randomUUID() },
    ]);
    const response = await unlink(actor, account.id);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'FAILED_TO_UNLINK_LAST_ACCOUNT' });
    expect(await accounts(actor.userId)).toHaveLength(3);
  });

  it('does not count an ambiguously owned retained provider as a usable sign-in method', async () => {
    const actor = await fixture({ credential: false, provider: 'google' });
    const another = await fixture();
    const selected = (await accounts(actor.userId))[0];
    const ambiguousSubject = randomUUID();
    await environment.database.insert(environment.schema.account).values([
      { id: randomUUID(), userId: actor.userId, providerId: 'apple', accountId: ambiguousSubject },
      { id: randomUUID(), userId: another.userId, providerId: 'apple', accountId: ambiguousSubject },
    ]);
    const response = await unlink(actor, selected.id);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'FAILED_TO_UNLINK_LAST_ACCOUNT' });
    expect((await accounts(actor.userId)).some((account) => account.id === selected.id)).toBe(true);
  });

  it.each(['duplicate', 'wrong-account-id'] as const)(
    'does not count an ambiguous or unusable %s credential as a remaining sign-in method',
    async (condition) => {
      const actor = await fixture({ credential: false, provider: 'google' });
      const selected = (await accounts(actor.userId))[0];
      if (condition === 'duplicate') {
        await environment.database.insert(environment.schema.account).values({
          id: randomUUID(),
          userId: actor.userId,
          providerId: 'credential',
          accountId: actor.userId,
          password: passwordHash,
        });
      }
      await environment.database.insert(environment.schema.account).values({
        id: randomUUID(),
        userId: actor.userId,
        providerId: 'credential',
        accountId: condition === 'wrong-account-id' ? randomUUID() : actor.userId,
        password: passwordHash,
      });
      const actualLogin = await authority.api.signInEmail({ body: { email: actor.email, password }, asResponse: true });
      // Stock can authenticate duplicate valid rows, but their selection is not a
      // unique credential authority. A foreign accountId is never selectable.
      expect(actualLogin.status).toBe(condition === 'duplicate' ? 200 : 401);
      const response = await unlink(actor, selected.id);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'FAILED_TO_UNLINK_LAST_ACCOUNT' });
      expect((await accounts(actor.userId)).some((account) => account.id === selected.id)).toBe(true);
      expect((await session(actor.cookie))?.user.id).toBe(actor.userId);
    },
  );

  it.each(['client', 'audience'] as const)(
    'does not count a retained provider with empty %s configuration',
    async (missing) => {
      const actor = await fixture({ credential: false, provider: 'google' });
      const selected = (await accounts(actor.userId))[0];
      await environment.database
        .insert(environment.schema.account)
        .values({ id: randomUUID(), userId: actor.userId, providerId: 'apple', accountId: randomUUID() });
      const apple = providerOptions.socialProviders?.apple;
      if (!apple || typeof apple !== 'object') throw new Error('Missing static Apple fixture options');
      const configured = createPrototypeProviderLinkLifecycle(environment.database, {
        authority: {
          ...providerOptions,
          socialProviders: {
            ...providerOptions.socialProviders,
            apple: { ...apple, ...(missing === 'client' ? { clientId: '' } : { audience: [''] }) },
          },
        },
      });
      const response = await unlink(actor, selected.id, configured);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'FAILED_TO_UNLINK_LAST_ACCOUNT' });
    },
  );

  it('does not unlink another user’s provider account', async () => {
    const owner = await fixture({ provider: 'google' });
    const actor = await fixture();
    const target = (await accounts(owner.userId)).find((account) => account.providerId === 'google')!;
    const response = await unlink(actor, target.id);
    expect(response.status).toBe(400);
    expect(await accounts(owner.userId)).toHaveLength(2);
  });

  it('two users racing to link one verified subject cannot acquire the same identity', async () => {
    const first = await fixture();
    const second = await fixture();
    const subject = randomUUID();
    const proof = { token: await token('google', subject) };
    const outcomes = await Promise.all([
      link(first, 'google', proof, primary),
      link(second, 'google', proof, secondary),
    ]);
    expect(
      outcomes.map((response) => response.status).sort((firstStatus, secondStatus) => firstStatus - secondStatus),
    ).toEqual([200, 409]);
    const owner = await environment.database
      .select()
      .from(environment.schema.account)
      .where(
        and(eq(environment.schema.account.providerId, 'google'), eq(environment.schema.account.accountId, subject)),
      );
    expect(owner).toHaveLength(1);
    expect([first.userId, second.userId]).toContain(owner[0].userId);
  });

  it('rolls back provider write, revocation and prepared replacement when a trusted hook fails', async () => {
    const actor = await fixture();
    const failing = createPrototypeProviderLinkLifecycle(environment.database, {
      authority: providerOptions,
      afterMutation: async () => {
        throw new Error('Injected provider lifecycle failure');
      },
    });
    const response = await link(actor, 'google', { token: await token('google', randomUUID()) }, failing);
    expect(response.status).toBe(500);
    expect(cookies(response)).toBe('');
    expect(await accounts(actor.userId)).toHaveLength(1);
    expect((await session(actor.cookie))?.user.id).toBe(actor.userId);
    const cutoff = await environment.database
      .select()
      .from(environment.schema.prototypeUserCutoff)
      .where(eq(environment.schema.prototypeUserCutoff.userId, actor.userId));
    expect(cutoff).toHaveLength(0);
  });

  async function beginFacebook(actor: { cookie: string }) {
    const response = await primary.handler(
      request(PROTOTYPE_PROVIDER_LINK_PATHS.link, actor.cookie, { provider: 'facebook' }),
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { url: string };
    const state = new URL(result.url).searchParams.get('state');
    if (!state) throw new Error('Missing provider state');
    return { state, cookie: `${actor.cookie}; ${cookies(response)}` };
  }
  function callback(started: { state: string; cookie: string }, subject = randomUUID(), cookie = started.cookie) {
    const code = randomUUID();
    facebookCodes.set(code, { subject, email: `${subject}@provider.example.test` });
    const url = new URL(PROTOTYPE_FACEBOOK_CALLBACK_URL);
    url.search = new URLSearchParams({ state: started.state, code }).toString();
    return secondary.handler(new Request(url, { headers: { cookie } }));
  }

  async function resetLink(actor: { userId: string }) {
    const resetToken = randomUUID();
    await environment.database.insert(environment.schema.verification).values({
      id: randomUUID(),
      identifier: `reset-password:${resetToken}`,
      value: actor.userId,
      expiresAt: new Date(Date.now() + 600_000),
    });
    return () =>
      createPrototypeLegacyHandler(environment.database)(
        request('/reset-password', '', {
          token: resetToken,
          newPassword: 'provider-race-reset-password',
        }),
      );
  }

  async function partnerTokens(actor: { cookie: string }) {
    const redirectUri = `https://client.example.test/provider-link/${randomUUID()}`;
    const client = await authority.api.adminCreateOAuthClient({
      headers: new Headers({ cookie: actor.cookie }),
      body: {
        client_name: 'Provider link partner fixture',
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
    const url = new URL(`${PROTOTYPE_ISSUER}/oauth2/authorize`);
    url.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'profile:read offline_access',
      state: randomUUID(),
      resource: PROTOTYPE_RESOURCE,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    const oauth = createSerializedPrototypeOAuthHandler(environment.database);
    const authorized = await oauth.handler(new Request(url, { headers: { cookie: actor.cookie } }));
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code');
    expect(code).toBeTruthy();
    async function post(path: string, fields: Record<string, string>) {
      const response = await oauth.handler(
        new Request(`${PROTOTYPE_ISSUER}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret!, ...fields }),
        }),
      );
      return { response, body: (await response.json()) as Record<string, unknown> };
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
    return { clientId: client.client_id, accessToken, refreshToken, post };
  }

  it('rejects untrusted form POSTs and normalizes a trusted form before the actor-bound GET proof', async () => {
    const actor = await fixture();
    const started = await beginFacebook(actor);
    const code = randomUUID();
    facebookCodes.set(code, { subject: randomUUID(), email: 'form-callback@provider.example.test' });
    const rejected = await secondary.handler(
      new Request(PROTOTYPE_FACEBOOK_CALLBACK_URL, {
        method: 'POST',
        headers: {
          cookie: started.cookie,
          origin: 'https://www.facebook.com',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ state: started.state, code }),
      }),
    );
    expect(rejected.status).toBe(403);
    expect(cookies(rejected)).toBe('');
    expect(outbound).toHaveLength(0);
    const normalized = await secondary.handler(
      new Request(PROTOTYPE_FACEBOOK_CALLBACK_URL, {
        method: 'POST',
        headers: {
          cookie: started.cookie,
          origin: 'https://www.boardsesh.test',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ state: started.state, code }),
      }),
    );
    expect(normalized.status).toBe(302);
    expect(outbound).toHaveLength(0);
    const next = new URL(normalized.headers.get('location')!);
    expect(next.origin + next.pathname).toBe(PROTOTYPE_FACEBOOK_CALLBACK_URL);
    const completed = await secondary.handler(new Request(next, { headers: { cookie: started.cookie } }));
    expect(completed.headers.get('location')).toBe(PROTOTYPE_PROVIDER_LINK_CALLBACK);
    await assertContinuation(actor, completed);
    expect((await secondary.handler(new Request(next, { headers: { cookie: started.cookie } }))).status).toBe(401);
  });

  it.each(['https://appleid.apple.com', 'https://www.facebook.com', undefined])(
    'cookie-less form POST with origin %s only normalizes before strict GET authentication',
    async (origin) => {
      const actor = await fixture();
      const started = await beginFacebook(actor);
      const before = await environment.database.select().from(environment.schema.verification);
      const code = randomUUID();
      facebookCodes.set(code, { subject: randomUUID(), email: 'cross-site-form@provider.example.test' });
      const normalized = await secondary.handler(
        new Request(PROTOTYPE_FACEBOOK_CALLBACK_URL, {
          method: 'POST',
          headers: {
            ...(origin ? { origin } : {}),
            'content-type': 'application/x-www-form-urlencoded',
            'sec-fetch-site': 'cross-site',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
          },
          body: new URLSearchParams({ state: started.state, code }),
        }),
      );
      expect(normalized.status).toBe(302);
      expect(cookies(normalized)).toBe('');
      expect(outbound).toHaveLength(0);
      expect(await environment.database.select().from(environment.schema.verification)).toEqual(before);
      const next = new URL(normalized.headers.get('location')!);
      expect(next.origin + next.pathname).toBe(PROTOTYPE_FACEBOOK_CALLBACK_URL);
      // The normalization itself is unauthenticated. It cannot exchange a code
      // without the canonical and signed state cookies returning on the GET.
      expect((await secondary.handler(new Request(next))).status).toBe(401);
      expect(outbound).toHaveLength(0);
      const completed = await secondary.handler(new Request(next, { headers: { cookie: started.cookie } }));
      expect(completed.headers.get('location')).toBe(PROTOTYPE_PROVIDER_LINK_CALLBACK);
      await assertContinuation(actor, completed);
    },
  );

  it('completes actual Apple code exchange after cookie-less form-post normalization', async () => {
    const actor = await fixture();
    const begun = await primary.handler(
      request(PROTOTYPE_PROVIDER_LINK_PATHS.link, actor.cookie, { provider: 'apple' }),
    );
    expect(begun.status).toBe(200);
    const authorization = new URL(((await begun.json()) as { url: string }).url);
    expect(authorization.origin + authorization.pathname).toBe('https://appleid.apple.com/auth/authorize');
    expect(authorization.searchParams.get('response_mode')).toBe('form_post');
    const state = authorization.searchParams.get('state');
    expect(state).toBeTruthy();
    const code = randomUUID();
    const subject = randomUUID();
    appleCodes.set(code, await token('apple', subject, { email_verified: 'true' }));
    const normalized = await secondary.handler(
      new Request(`${PROTOTYPE_ISSUER}/callback/apple`, {
        method: 'POST',
        headers: {
          origin: 'https://appleid.apple.com',
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        },
        body: new URLSearchParams({ state: state!, code }),
      }),
    );
    expect(normalized.status).toBe(302);
    expect(cookies(normalized)).toBe('');
    expect(outbound).toHaveLength(0);
    const completed = await primary.handler(
      new Request(normalized.headers.get('location')!, {
        headers: { cookie: `${actor.cookie}; ${cookies(begun)}` },
      }),
    );
    expect(completed.headers.get('location')).toBe(PROTOTYPE_PROVIDER_LINK_CALLBACK);
    await assertContinuation(actor, completed);
    expect(
      (await accounts(actor.userId)).some((account) => account.providerId === 'apple' && account.accountId === subject),
    ).toBe(true);
    // Browser Apple ownership here comes from the authenticated code exchange.
    // Stock decodes its token-endpoint IDtoken; native nonce/JWKS verification
    // is separately exercised above and must not be claimed for this branch.
    expect(outbound).toEqual(['https://appleid.apple.com/auth/token']);
  });

  it('a missing signed state cookie spends the validated intent without linking or publishing a cookie', async () => {
    const actor = await fixture();
    const started = await beginFacebook(actor);
    const rejected = await callback(started, randomUUID(), actor.cookie);
    expect(rejected.status).toBe(302);
    expect(new URL(rejected.headers.get('location')!).searchParams.get('error')).toBeTruthy();
    expect(cookies(rejected)).toBe('');
    expect(await accounts(actor.userId)).toHaveLength(1);
    expect((await callback(started)).status).toBe(400);
    expect((await session(actor.cookie))?.user.id).toBe(actor.userId);
  });

  it('serializes two callbacks to one provider mutation and one replacement session', async () => {
    const actor = await fixture();
    const started = await beginFacebook(actor);
    const subject = randomUUID();
    const responses = await Promise.all([callback(started, subject), callback(started, subject)]);
    expect(responses.map((response) => response.status).sort((first, second) => first - second)).toEqual([302, 401]);
    expect((await accounts(actor.userId)).filter((account) => account.providerId === 'facebook')).toHaveLength(1);
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, actor.userId)),
    ).toHaveLength(1);
    expect(responses.filter((response) => cookies(response, 'better-auth.session_token='))).toHaveLength(1);
  });

  it('reset invalidates a pending provider callback before provider exchange', async () => {
    const actor = await fixture();
    const started = await beginFacebook(actor);
    expect((await (await resetLink(actor))()).status).toBe(200);
    expect((await callback(started)).status).toBe(401);
    expect(outbound).toHaveLength(0);
    expect(await accounts(actor.userId)).toHaveLength(1);
  });

  it('reset and provider callback share one fence without publishing a credential that survives a later reset', async () => {
    const actor = await fixture();
    const started = await beginFacebook(actor);
    const reset = await resetLink(actor);
    const [completed, recovered] = await Promise.all([callback(started), reset()]);
    if (recovered.status === 200) {
      expect(completed.status).toBe(401);
      expect(await accounts(actor.userId)).toHaveLength(1);
      expect(cookies(completed)).toBe('');
    } else {
      // A successful credential mutation invalidates reset links prepared before it.
      expect(recovered.status).toBe(400);
      expect(completed.headers.get('location')).toBe(PROTOTYPE_PROVIDER_LINK_CALLBACK);
      const replacement = cookies(completed, 'better-auth.session_token=');
      expect((await session(replacement))?.user.id).toBe(actor.userId);
      expect((await (await resetLink(actor))()).status).toBe(200);
      expect(await session(replacement)).toBeNull();
    }
    expect(await session(actor.cookie)).toBeNull();
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, actor.userId)),
    ).toHaveLength(0);
  });

  it('Disconnect racing with provider continuation leaves partner tokens dead and another user active', async () => {
    const actor = await fixture();
    const another = await fixture();
    const partner = await partnerTokens(actor);
    const unrelated = await partnerTokens(another);
    const started = await beginFacebook(actor);
    const [completed] = await Promise.all([
      callback(started),
      disconnectPrototypeOAuthConnection(environment.database, actor.userId, partner.clientId),
    ]);
    expect(completed.headers.get('location')).toBe(PROTOTYPE_PROVIDER_LINK_CALLBACK);
    await assertContinuation(actor, completed);
    expect((await partner.post('/oauth2/introspect', { token: partner.accessToken })).body.active).toBe(false);
    expect(
      (await partner.post('/oauth2/token', { grant_type: 'refresh_token', refresh_token: partner.refreshToken }))
        .response.status,
    ).toBe(400);
    expect((await unrelated.post('/oauth2/introspect', { token: unrelated.accessToken })).body.active).toBe(true);
  });

  it('links a real Facebook code flow on another instance and rejects callback replay', async () => {
    const actor = await fixture();
    const started = await beginFacebook(actor);
    const subject = randomUUID();
    const response = await callback(started, subject);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(PROTOTYPE_PROVIDER_LINK_CALLBACK);
    const replacement = await assertContinuation(actor, response);
    expect(replacement.current?.user.email).toBe(actor.email);
    expect(replacement.current?.user.emailVerified).toBe(false);
    expect(
      (await accounts(actor.userId)).some(
        (account) => account.providerId === 'facebook' && account.accountId === subject,
      ),
    ).toBe(true);
    const calls = outbound.length;
    const replay = await callback(
      started,
      subject,
      `${replacement.cookie}; ${started.cookie
        .split('; ')
        .filter((cookie) => !cookie.includes('session_token='))
        .join('; ')}`,
    );
    expect([400, 401]).toContain(replay.status);
    expect(cookies(replay)).toBe('');
    expect(outbound).toHaveLength(calls);
  });

  it('explicit Facebook trust never autoattaches an unknown matching-email subject on sign-in', async () => {
    const actor = await fixture({ verified: true });
    const ordinary = createSerializedPrototypeOAuthHandler(environment.database, {
      ...providerOptions,
      account: { accountLinking: PROTOTYPE_EXPLICIT_PROVIDER_LINK_POLICY },
    });
    const begun = await ordinary.handler(
      request('/sign-in/social', '', {
        provider: 'facebook',
        callbackURL: PROTOTYPE_PROVIDER_LINK_CALLBACK,
        errorCallbackURL: 'https://www.boardsesh.test/auth/login',
        disableRedirect: true,
      }),
    );
    expect(begun.status).toBe(200);
    const authorization = (await begun.json()) as { url: string };
    const state = new URL(authorization.url).searchParams.get('state')!;
    const code = randomUUID();
    facebookCodes.set(code, { subject: `unknown-${randomUUID()}`, email: actor.email });
    const url = new URL(PROTOTYPE_FACEBOOK_CALLBACK_URL);
    url.search = new URLSearchParams({ state, code }).toString();
    const completed = await ordinary.handler(new Request(url, { headers: { cookie: cookies(begun) } }));
    expect(completed.status).toBe(302);
    expect(new URL(completed.headers.get('location')!).searchParams.get('error')).toBe('account_not_linked');
    expect(cookies(completed, 'better-auth.session_token=')).toBe('');
    expect(await accounts(actor.userId)).toHaveLength(1);
  });

  it('a late response rejection never publishes a prepared provider-continuation cookie', async () => {
    const actor = await fixture();
    const failing = createPrototypeProviderLinkLifecycle(environment.database, {
      authority: {
        ...providerOptions,
        plugins: [
          {
            id: 'provider-link-late-rejection',
            hooks: {
              after: [
                {
                  matcher: (context) => context.path === PROTOTYPE_PROVIDER_LINK_PATHS.link,
                  handler: createAuthMiddleware(async () => {
                    throw new APIError('FORBIDDEN', { code: 'LATE_PROVIDER_POLICY_REJECTION' });
                  }),
                },
              ],
            },
          },
        ],
      },
    });
    const response = await link(actor, 'google', { token: await token('google', randomUUID()) }, failing);
    expect(response.status).toBe(403);
    expect(cookies(response)).toBe('');
    expect(await accounts(actor.userId)).toHaveLength(1);
    expect((await session(actor.cookie))?.user.id).toBe(actor.userId);
  });

  it('rejects an account-switch callback before provider exchange but permits the original actor', async () => {
    const actor = await fixture();
    const another = await fixture();
    const started = await beginFacebook(actor);
    const stateCookies = started.cookie
      .split('; ')
      .filter((cookie) => !cookie.includes('session_token='))
      .join('; ');
    const rejected = await callback(started, randomUUID(), `${another.cookie}; ${stateCookies}`);
    expect(rejected.status).toBe(400);
    expect(outbound).toHaveLength(0);
    const accepted = await callback(started);
    expect(accepted.status).toBe(302);
    await assertContinuation(actor, accepted);
    expect(await accounts(another.userId)).toHaveLength(1);
  });

  it('rejects a pending callback after the original fresh authentication ages out', async () => {
    const actor = await fixture();
    const started = await beginFacebook(actor);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    const response = await callback(started);
    expect(response.status).toBe(403);
    expect(outbound).toHaveLength(0);
    expect(await accounts(actor.userId)).toHaveLength(1);
  });

  it('cancellation spends a validated intent while preserving the actor and allowing a new flow', async () => {
    const actor = await fixture();
    const started = await beginFacebook(actor);
    const url = new URL(PROTOTYPE_FACEBOOK_CALLBACK_URL);
    url.search = new URLSearchParams({ state: started.state, error: 'access_denied' }).toString();
    const cancellation = await secondary.handler(new Request(url, { headers: { cookie: started.cookie } }));
    expect(cancellation.status).toBe(302);
    expect(new URL(cancellation.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect(cookies(cancellation)).toBe('');
    expect(await accounts(actor.userId)).toHaveLength(1);
    expect((await session(actor.cookie))?.user.id).toBe(actor.userId);
    const retry = await callback(started);
    expect(retry.status).toBe(400);
    expect(outbound).toHaveLength(0);
    const restarted = await beginFacebook(actor);
    expect(restarted.state).not.toBe(started.state);
    expect((await callback(restarted)).headers.get('location')).toBe(PROTOTYPE_PROVIDER_LINK_CALLBACK);
  });

  it.each([
    'late403',
    'globalLate403',
    'lateResponse403',
    'globalResponse403',
    'contextError403',
    'globalContextError403',
    'afterMutation500',
    'lateErrorRedirect',
  ] as const)('callback %s rolls back credentials but leaves the validated intent spent', async (failure) => {
    const actor = await fixture();
    const started = await beginFacebook(actor);
    const failing = createPrototypeProviderLinkLifecycle(environment.database, {
      authority: {
        ...providerOptions,
        ...(failure === 'globalLate403' || failure === 'globalResponse403' || failure === 'globalContextError403'
          ? {
              hooks: {
                after: createAuthMiddleware(async (context) => {
                  if (context.path !== '/callback/:id' || context.method !== 'GET') return;
                  if (failure === 'globalResponse403')
                    return Response.json({ code: 'GLOBAL_LATE_CALLBACK_REJECTION' }, { status: 403 });
                  if (failure === 'globalContextError403')
                    throw context.error('FORBIDDEN', { code: 'GLOBAL_LATE_CALLBACK_REJECTION' });
                  throw new APIError('FORBIDDEN', { code: 'GLOBAL_LATE_CALLBACK_REJECTION' });
                }),
              },
            }
          : failure === 'afterMutation500'
            ? {}
            : {
                plugins: [
                  {
                    id: 'provider-link-callback-late-rejection',
                    hooks: {
                      after: [
                        {
                          matcher: (context) => context.path === '/callback/:id',
                          handler: createAuthMiddleware(async (context) => {
                            if (failure === 'lateErrorRedirect')
                              throw context.redirect('https://www.boardsesh.test/settings?providerLink=late-error');
                            if (failure === 'lateResponse403')
                              return Response.json({ code: 'LATE_CALLBACK_REJECTION' }, { status: 403 });
                            if (failure === 'contextError403')
                              throw context.error('FORBIDDEN', { code: 'LATE_CALLBACK_REJECTION' });
                            throw new APIError('FORBIDDEN', { code: 'LATE_CALLBACK_REJECTION' });
                          }),
                        },
                      ],
                    },
                  },
                ],
              }),
      },
      ...(failure === 'afterMutation500'
        ? {
            afterMutation: async () => {
              throw new Error('Injected post-link continuation failure');
            },
          }
        : {}),
    });
    const code = randomUUID();
    facebookCodes.set(code, { subject: randomUUID(), email: 'proved-subject@provider.example.test' });
    const url = new URL(PROTOTYPE_FACEBOOK_CALLBACK_URL);
    url.search = new URLSearchParams({ state: started.state, code }).toString();
    const rejected = await failing.handler(new Request(url, { headers: { cookie: started.cookie } }));
    expect(rejected.status).toBe(failure === 'afterMutation500' ? 500 : failure === 'lateErrorRedirect' ? 302 : 403);
    expect(cookies(rejected)).toBe('');
    expect(await accounts(actor.userId)).toHaveLength(1);
    expect((await session(actor.cookie))?.user.id).toBe(actor.userId);
    const callCount = outbound.length;
    expect((await callback(started)).status).toBe(400);
    expect(outbound).toHaveLength(callCount);
    const restarted = await beginFacebook(actor);
    const completed = await callback(restarted);
    expect(completed.headers.get('location')).toBe(PROTOTYPE_PROVIDER_LINK_CALLBACK);
  });

  it('a password continuation cannot take over an earlier provider-link intent', async () => {
    const actor = await fixture();
    const started = await beginFacebook(actor);
    const changed = await createPrototypeLifecycleMutations(environment.database).handler(
      request(PROTOTYPE_LIFECYCLE_PATHS.changePassword, actor.cookie, {
        currentPassword: password,
        newPassword: 'new-password-before-provider-callback',
      }),
    );
    expect(changed.status).toBe(200);
    const stateCookies = started.cookie
      .split('; ')
      .filter((cookie) => !cookie.includes('session_token='))
      .join('; ');
    const response = await callback(
      started,
      randomUUID(),
      `${cookies(changed, 'better-auth.session_token=')}; ${stateCookies}`,
    );
    expect(response.status).toBe(400);
    expect(outbound).toHaveLength(0);
    expect(await accounts(actor.userId)).toHaveLength(1);
  });
});
