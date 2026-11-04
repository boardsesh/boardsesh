import { createHash, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { createPrototypeNativeFacade } from '../identity-native-facade';
import { assertLegacyNativeTokenPair } from './identity-native-contract';
import { planPrototypeIdentityImport, type PrototypeLegacyIdentity } from '../identity-fixtures';
import {
  createIdentityPrototypeOptions,
  PROTOTYPE_APPLE_AUDIENCES,
  PROTOTYPE_GOOGLE_AUDIENCES,
} from '../identity-providers';
import { PROTOTYPE_ISSUER } from '../oauth-options';

type PrototypeEnvironment = Awaited<ReturnType<typeof createPrototypeEnvironment>>;
type PrototypeAuthority = PrototypeEnvironment['auth'];
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

const legacyPassword = ' café-山-🧗-password ';
const fixtureKeyId = 'boardsesh-synthetic-provider-key';
let environment: PrototypeEnvironment;
let authority: PrototypeAuthority;
let secondaryAuthority: PrototypeAuthority;
let signingKey: SigningKey;
let wrongSigningKey: SigningKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;
let passwordHash: string;
let providerOptions: ReturnType<typeof createIdentityPrototypeOptions>;

async function seedIdentity(overrides: Partial<PrototypeLegacyIdentity> = {}) {
  const identityId = randomUUID();
  const identity: PrototypeLegacyIdentity = {
    id: identityId,
    email: `climber-${identityId}@example.com`,
    name: 'Synthetic climber',
    image: null,
    emailVerifiedAt: new Date('2024-02-03T04:05:06.000Z'),
    createdAt: new Date('2023-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    passwordHash,
    providers: [
      { provider: 'apple', subject: `apple-${identityId}` },
      { provider: 'google', subject: `google-${identityId}` },
    ],
    ...overrides,
  };
  const planned = planPrototypeIdentityImport([identity]);
  await environment.database.transaction(async (transaction) => {
    await transaction.insert(environment.schema.user).values(planned.users);
    if (planned.accounts.length > 0) await transaction.insert(environment.schema.account).values(planned.accounts);
  });
  return identity;
}

function request(path: string, body?: unknown, cookie?: string) {
  const headers = new Headers({ origin: 'https://www.boardsesh.test' });
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (cookie) headers.set('cookie', cookie);
  return new Request(`${PROTOTYPE_ISSUER}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function sessionCookie(response: Response) {
  const cookie = response.headers.getSetCookie().find((header) => header.includes('better-auth.session_token='));
  expect(cookie).toBeDefined();
  return cookie!.split(';')[0];
}

async function providerToken(
  provider: 'apple' | 'google',
  subject: string,
  overrides: JWTPayload = {},
  key = signingKey,
) {
  return new SignJWT({
    iss: provider === 'apple' ? 'https://appleid.apple.com' : 'https://accounts.google.com',
    aud: provider === 'apple' ? PROTOTYPE_APPLE_AUDIENCES[0] : PROTOTYPE_GOOGLE_AUDIENCES[0],
    sub: subject,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    email_verified: true,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: fixtureKeyId })
    .sign(key);
}

function signInProvider(provider: 'apple' | 'google', token: string, nonce?: string) {
  return authority.handler(request('/sign-in/social', { provider, idToken: { token, ...(nonce ? { nonce } : {}) } }));
}

describe('pinned Better Auth identity and native-provider integration', () => {
  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    const keyPair = await generateKeyPair('RS256');
    signingKey = keyPair.privateKey;
    publicJwk = await exportJWK(keyPair.publicKey);
    wrongSigningKey = (await generateKeyPair('RS256')).privateKey;
    // A lower-cost synthetic legacy hash keeps the fixture cheap; its bytes
    // must be preserved, while new authority writes use the configured cost 12.
    passwordHash = await hash(legacyPassword, 4);
    providerOptions = createIdentityPrototypeOptions(async (subject) => {
      const matched = await environment.database
        .select({
          email: environment.schema.user.email,
          name: environment.schema.user.name,
          emailVerified: environment.schema.user.emailVerified,
        })
        .from(environment.schema.account)
        .innerJoin(environment.schema.user, eq(environment.schema.user.id, environment.schema.account.userId))
        .where(
          and(eq(environment.schema.account.providerId, 'apple'), eq(environment.schema.account.accountId, subject)),
        )
        .limit(1);
      return matched[0] ?? null;
    });
    authority = environment.createAuthority(providerOptions);
    secondaryAuthority = environment.createAuthority(providerOptions);
  }, 60_000);

  beforeEach(() => {
    // Only the remote provider key transport is replaced. Better Auth's real
    // provider implementation and jose signature/claim/nonce checks run intact.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url !== 'https://appleid.apple.com/auth/keys' && url !== 'https://www.googleapis.com/oauth2/v3/certs') {
          throw new Error('Unexpected outbound request in native provider prototype');
        }
        return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: fixtureKeyId, alg: 'RS256', use: 'sig' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => environment?.close());

  it('authenticates imported bcrypt without changing user ID, hash bytes or verification timestamp', async () => {
    const identity = await seedIdentity();
    const response = await authority.handler(
      request('/sign-in/email', { email: identity.email.toUpperCase(), password: legacyPassword }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: identity.id, emailVerified: true } });

    const [storedUser] = await environment.database
      .select()
      .from(environment.schema.user)
      .where(eq(environment.schema.user.id, identity.id));
    const [storedCredential] = await environment.database
      .select()
      .from(environment.schema.account)
      .where(
        and(
          eq(environment.schema.account.userId, identity.id),
          eq(environment.schema.account.providerId, 'credential'),
        ),
      );
    expect(storedUser.legacyEmailVerifiedAt).toEqual(identity.emailVerifiedAt);
    expect(storedCredential.password).toBe(passwordHash);
    expect(storedCredential.accountId).toBe(identity.id);
  });

  it('preserves unverified status instead of inferring verification from a password', async () => {
    const identity = await seedIdentity({ emailVerifiedAt: null });
    const response = await authority.handler(
      request('/sign-in/email', { email: identity.email, password: legacyPassword }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: identity.id, emailVerified: false } });
  });

  it('uses the same generic rejection for a wrong password and an unknown email', async () => {
    const identity = await seedIdentity();
    const knownResponse = await authority.handler(
      request('/sign-in/email', { email: identity.email, password: 'wrong-password' }),
    );
    const unknownResponse = await authority.handler(
      request('/sign-in/email', { email: 'unknown@example.com', password: 'wrong-password' }),
    );
    expect(knownResponse.status).toBe(401);
    expect(unknownResponse.status).toBe(401);
    expect(await knownResponse.json()).toEqual(await unknownResponse.json());
  });

  it('records the stock whitespace-email limitation before normalization glue is added', async () => {
    const identity = await seedIdentity();
    const response = await authority.handler(
      request('/sign-in/email', { email: ` ${identity.email} `, password: legacyPassword }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_EMAIL' });
  });

  it.each(PROTOTYPE_GOOGLE_AUDIENCES)(
    'accepts configured native Google audience %s without relinking by email',
    async (audience) => {
      const identity = await seedIdentity();
      const subject = identity.providers.find((provider) => provider.provider === 'google')!.subject;
      const token = await providerToken('google', subject, {
        aud: audience,
        email: 'changed-provider-claim@example.com',
        name: 'Provider name',
      });
      const response = await signInProvider('google', token);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ user: { id: identity.id, email: identity.email } });
    },
  );

  it('accepts the second supported Google issuer spelling', async () => {
    const identity = await seedIdentity();
    const subject = identity.providers.find((provider) => provider.provider === 'google')!.subject;
    const response = await signInProvider(
      'google',
      await providerToken('google', subject, { iss: 'accounts.google.com', email: identity.email }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: identity.id } });
  });

  it.each(PROTOTYPE_APPLE_AUDIENCES)(
    'restores returning Apple relay identity without email/name for audience %s',
    async (audience) => {
      const identity = await seedIdentity({ email: `${randomUUID()}@privaterelay.appleid.com` });
      const subject = identity.providers.find((provider) => provider.provider === 'apple')!.subject;
      const rawNonce = 'prototype-apple-nonce';
      const token = await providerToken('apple', subject, {
        aud: audience,
        nonce: createHash('sha256').update(rawNonce).digest('hex'),
        email_verified: 'true',
      });
      const response = await signInProvider('apple', token, rawNonce);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        user: { id: identity.id, email: identity.email, name: identity.name },
      });
    },
  );

  it('does not upgrade an unverified imported Apple identity during email fallback', async () => {
    const identity = await seedIdentity({ emailVerifiedAt: null });
    const subject = identity.providers.find((provider) => provider.provider === 'apple')!.subject;
    const response = await signInProvider('apple', await providerToken('apple', subject));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: identity.id, emailVerified: false } });
  });

  it('rejects an unknown Apple subject without email and never creates a synthetic identity', async () => {
    const unknownSubject = `unknown-${randomUUID()}`;
    const response = await signInProvider('apple', await providerToken('apple', unknownSubject));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'USER_EMAIL_NOT_FOUND' });
    expect(
      await environment.database
        .select()
        .from(environment.schema.account)
        .where(eq(environment.schema.account.accountId, unknownSubject)),
    ).toEqual([]);
  });

  it('rejects an unknown Google subject matching an existing email instead of attaching it', async () => {
    const identity = await seedIdentity();
    const unknownSubject = `unlinked-${randomUUID()}`;
    const response = await signInProvider(
      'google',
      await providerToken('google', unknownSubject, { email: identity.email }),
    );
    expect(response.status).toBe(401);
    expect(
      await environment.database
        .select()
        .from(environment.schema.account)
        .where(eq(environment.schema.account.accountId, unknownSubject)),
    ).toEqual([]);
  });

  it.each([
    ['wrong audience', { aud: 'untrusted-client' }],
    ['wrong issuer', { iss: 'https://attacker.example.com' }],
    ['expired token', { exp: Math.floor(Date.now() / 1000) - 120 }],
    ['missing subject', { sub: undefined }],
    ['future issuance', { iat: Math.floor(Date.now() / 1000) + 120 }],
  ] as const)('rejects authentic provider tokens with %s', async (_reason, claims) => {
    const identity = await seedIdentity();
    const subject = identity.providers.find((provider) => provider.provider === 'google')!.subject;
    const response = await signInProvider(
      'google',
      await providerToken('google', subject, { email: identity.email, ...claims }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'INVALID_TOKEN' });
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, identity.id)),
    ).toEqual([]);
  });

  it('rejects a forged provider signature even when subject and audience are valid', async () => {
    const identity = await seedIdentity();
    const subject = identity.providers.find((provider) => provider.provider === 'apple')!.subject;
    const response = await signInProvider(
      'apple',
      await providerToken('apple', subject, { email: identity.email }, wrongSigningKey),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects an incorrect Apple nonce before persisted-email fallback', async () => {
    const identity = await seedIdentity();
    const subject = identity.providers.find((provider) => provider.provider === 'apple')!.subject;
    const response = await signInProvider(
      'apple',
      await providerToken('apple', subject, { nonce: 'another-attempt' }),
      'expected-attempt',
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('allows ordinary use but rejects freshness-gated operations for an imported old session', async () => {
    const identity = await seedIdentity();
    const signIn = await authority.handler(
      request('/sign-in/email', { email: identity.email, password: legacyPassword }),
    );
    const cookie = sessionCookie(signIn);
    const originalAuthenticatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await environment.database
      .update(environment.schema.session)
      .set({ createdAt: originalAuthenticatedAt, originalAuthenticatedAt })
      .where(eq(environment.schema.session.userId, identity.id));

    const ordinaryResponse = await secondaryAuthority.handler(request('/get-session', undefined, cookie));
    expect(ordinaryResponse.status).toBe(200);
    expect(await ordinaryResponse.json()).toMatchObject({
      user: { id: identity.id },
      session: { createdAt: originalAuthenticatedAt.toISOString() },
    });
    const sensitiveResponse = await secondaryAuthority.handler(request('/list-sessions', undefined, cookie));
    expect(sensitiveResponse.status).toBe(403);
    expect(await sensitiveResponse.json()).toMatchObject({ code: 'SESSION_NOT_FRESH' });
  });

  it('rejects a revoked cookie on a second authority and after creating another authority instance', async () => {
    const identity = await seedIdentity();
    const signIn = await authority.handler(
      request('/sign-in/email', { email: identity.email, password: legacyPassword }),
    );
    const cookie = sessionCookie(signIn);
    const signOut = await secondaryAuthority.handler(request('/sign-out', {}, cookie));
    expect(signOut.status).toBe(200);
    expect(await (await authority.handler(request('/get-session', undefined, cookie))).json()).toBeNull();
    const restartedAuthority = environment.createAuthority();
    expect(await (await restartedAuthority.handler(request('/get-session', undefined, cookie))).json()).toBeNull();
  });

  it.each(['google', 'apple'] as const)(
    'returns the native/watch token-pair contract after central %s ID-token verification',
    async (provider) => {
      const identity = await seedIdentity();
      const subject = identity.providers.find((linked) => linked.provider === provider)!.subject;
      const nativeKey = new TextEncoder().encode('synthetic-provider-to-native-contract-key');
      const facade = createPrototypeNativeFacade(environment.database, nativeKey, providerOptions);
      const token = await providerToken(
        provider,
        subject,
        provider === 'google' ? { aud: PROTOTYPE_GOOGLE_AUDIENCES[1], email: identity.email } : {},
      );
      const response = await facade.social(provider, { token });
      await assertLegacyNativeTokenPair(response, nativeKey, identity.id);
      expect(await facade.validateAccessToken(response.jwt)).toMatchObject({ userId: identity.id });
      expect((await facade.refresh(response.refreshToken)).userId).toBe(identity.id);
    },
  );
});
