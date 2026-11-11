import { createHash, createHmac, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { users, accounts, userCredentials, mobileRefreshTokens } from '@boardsesh/db/schema/auth';
import { NATIVE_V1_PATHS } from '@boardsesh/auth-protocol/native-v1';
import { recordings } from './recordings';
import { callRecorded, createReleasedClient } from './released-client';
import { createNativeHttpFixture } from './http-fixture';

// Replace only the provider's remote JWKS transport. Signature, issuer,
// audience, nonce, subject resolution and all database writes stay real.
const providerJwks = vi.hoisted(() => ({ keys: [] as JWK[] }));
vi.mock('jose', async (importOriginal) => {
  const original = await importOriginal<typeof import('jose')>();
  return {
    ...original,
    createRemoteJWKSet: (url: URL, options?: Parameters<typeof original.createRemoteJWKSet>[1]) =>
      original.createRemoteJWKSet(url, {
        ...options,
        [original.customFetch]: async () => {
          if (
            !['https://appleid.apple.com/auth/keys', 'https://www.googleapis.com/oauth2/v3/certs'].includes(
              url.toString(),
            )
          )
            throw new Error('Unrecorded provider network refused');
          return Response.json({ keys: providerJwks.keys });
        },
      }),
  };
});
let providerPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let fixture: Awaited<ReturnType<typeof createNativeHttpFixture>>;
const ownerId = randomUUID();
const email = `native-contract-${ownerId}@example.test`;
const password = 'synthetic-contract-password';
interface Pair {
  jwt: string;
  refreshToken: string;
  expiresAt: string;
  userId?: string;
}
async function assertPair(pair: Pair, expectedOwner: string = ownerId) {
  expect(pair.refreshToken).toMatch(/^[a-f0-9]{64}$/);
  expect(Number.isFinite(Date.parse(pair.expiresAt))).toBe(true);
  const verified = await jwtVerify(pair.jwt, new TextEncoder().encode(process.env.NEXTAUTH_SECRET), {
    issuer: 'boardsesh',
    audience: 'boardsesh-mobile',
    algorithms: ['HS256'],
  });
  expect(verified.payload.sub).toBe(expectedOwner);
  expect(pair.jwt.split('.')).toHaveLength(3);
  const rows = await fixture.db
    .select()
    .from(mobileRefreshTokens)
    .where(eq(mobileRefreshTokens.tokenHash, createHash('sha256').update(pair.refreshToken).digest('hex')));
  expect(rows).toHaveLength(1);
  expect(rows[0].userId).toBe(expectedOwner);
}

describe('released clients against mounted native handlers, primary Postgres and Redis', () => {
  beforeAll(async () => {
    const keys = await generateKeyPair('RS256');
    providerPrivateKey = keys.privateKey;
    providerJwks.keys = [{ ...(await exportJWK(keys.publicKey)), kid: 'synthetic-provider', alg: 'RS256', use: 'sig' }];
    process.env.GOOGLE_WEB_CLIENT_ID = 'native-contract-google';
    fixture = await createNativeHttpFixture();
    await fixture.db.insert(users).values({ id: ownerId, email, name: 'Synthetic fixture' });
    await fixture.db.insert(userCredentials).values({ userId: ownerId, passwordHash: await hash(password, 4) });
    await fixture.db.insert(accounts).values(
      ['apple', 'google'].map((provider) => ({
        userId: ownerId,
        type: 'oauth' as const,
        provider,
        providerAccountId: `synthetic-${provider}-${ownerId}`,
      })),
    );
  });
  beforeEach(() => {
    fixture.native.__resetNativeAuthStateForTests();
    fixture.requests.length = 0;
  });
  afterAll(async () => {
    await fixture?.close();
  });

  for (const release of recordings.releases) {
    it(`credentials, refresh rotation and rejection: ${release.tag}`, async () => {
      const client = await createReleasedClient(release, { fetch: fixture.network });
      const result = await callRecorded(client.auth, 'signInWithCredentials', email, password);
      expect(result).toMatchObject({ success: true });
      const jwt = await callRecorded(client.store, 'getAuthToken');
      const refreshToken = await callRecorded(client.store, 'getRefreshToken');
      expect(typeof jwt).toBe('string');
      expect(typeof refreshToken).toBe('string');
      await assertPair({
        jwt: jwt as string,
        refreshToken: refreshToken as string,
        expiresAt: ((await callRecorded(client.store, 'getTokenExpiresAt')) as Date).toISOString(),
      });
      const refreshed = await callRecorded(client.interceptor, 'deduplicatedRefresh');
      expect(
        typeof refreshed === 'boolean' ? refreshed : (refreshed as { status: string }).status === 'refreshed',
      ).toBe(true);
      expect(await callRecorded(client.store, 'getRefreshToken')).not.toBe(refreshToken);
      expect(fixture.requests[0]).toMatchObject({
        path: '/auth/native/credentials',
        method: 'POST',
        body: { email, password },
      });
      expect(fixture.requests[1]).toMatchObject({ path: '/auth/native/refresh', body: { refreshToken } });
      // These paths come from the frozen client, whose execution never imports
      // the shared vocabulary. Keep the independent literal controls above.
      expect(fixture.requests[0].path).toBe(NATIVE_V1_PATHS.credentials);
      expect(fixture.requests[1].path).toBe(NATIVE_V1_PATHS.refresh);
      const replay = await fixture.post('/auth/native/refresh', { refreshToken });
      expect(replay.status).toBe(401);
      expect(await replay.json()).toMatchObject({ error: 'Invalid refresh token' });
    });
  }

  for (const release of recordings.releases) {
    it(`signed Apple/Google subject returns to the same account: ${release.tag}`, async () => {
      const client = await createReleasedClient(release, {
        fetch: fixture.network,
        providerToken: async (provider, nonceHash) =>
          new SignJWT({ sub: `synthetic-${provider}-${ownerId}`, ...(nonceHash ? { nonce: nonceHash } : {}) })
            .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-provider' })
            .setIssuer(provider === 'apple' ? 'https://appleid.apple.com' : 'https://accounts.google.com')
            .setAudience(provider === 'apple' ? 'com.boardsesh.app' : 'native-contract-google')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(providerPrivateKey),
      });
      for (const provider of ['Apple', 'Google']) {
        expect(await callRecorded(client.auth, `signInWith${provider}`)).toMatchObject({ success: true });
        const jwt = await callRecorded(client.store, 'getAuthToken');
        const refreshToken = await callRecorded(client.store, 'getRefreshToken');
        await assertPair({
          jwt: jwt as string,
          refreshToken: refreshToken as string,
          expiresAt: ((await callRecorded(client.store, 'getTokenExpiresAt')) as Date).toISOString(),
        });
      }
      expect(fixture.requests.map((request) => request.path)).toEqual(['/auth/native/oauth', '/auth/native/oauth']);
      for (const request of fixture.requests) expect(request.path).toBe(NATIVE_V1_PATHS.oauth);
      expect(fixture.requests[0].body).toMatchObject({
        provider: 'apple',
        identityToken: expect.any(String),
        nonce: expect.any(String),
      });
      expect(fixture.requests[1].body).toMatchObject({ provider: 'google', identityToken: expect.any(String) });
    });
    it(`new email account and duplicate refusal retain the released parser: ${release.tag}`, async () => {
      const createdEmail = `registration-${randomUUID()}@example.test`;
      const client = await createReleasedClient(release, { fetch: fixture.network });
      expect(
        await callRecorded(client.auth, 'registerWithCredentials', createdEmail, password, 'Synthetic registration'),
      ).toMatchObject({ success: true });
      const [created] = await fixture.db.select().from(users).where(eq(users.email, createdEmail));
      expect(created).toBeDefined();
      await assertPair(
        {
          jwt: (await callRecorded(client.store, 'getAuthToken')) as string,
          refreshToken: (await callRecorded(client.store, 'getRefreshToken')) as string,
          expiresAt: ((await callRecorded(client.store, 'getTokenExpiresAt')) as Date).toISOString(),
        },
        created.id,
      );
      expect(fixture.requests[0]).toMatchObject({
        path: '/auth/native/register',
        body: { email: createdEmail, password, name: 'Synthetic registration' },
      });
      expect(fixture.requests[0].path).toBe(NATIVE_V1_PATHS.register);
      expect(await callRecorded(client.auth, 'registerWithCredentials', createdEmail, password)).toMatchObject({
        success: false,
        status: 409,
      });
    });
  }

  for (const release of recordings.releases) {
    for (const provider of ['apple', 'google'] as const) {
      it(`new ${provider} subject followed by email-less return: ${release.tag}`, async () => {
        const subject = `new-${provider}-${randomUUID()}`;
        const createdEmail = `oauth-${randomUUID()}@example.test`;
        const signed = async (includeEmail: boolean) =>
          new SignJWT({ sub: subject, ...(includeEmail ? { email: createdEmail, email_verified: true } : {}) })
            .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-provider' })
            .setIssuer(provider === 'apple' ? 'https://appleid.apple.com' : 'https://accounts.google.com')
            .setAudience(provider === 'apple' ? 'com.boardsesh.app' : 'native-contract-google')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(providerPrivateKey);
        const client = await createReleasedClient(release, { fetch: fixture.network });
        const first = await callRecorded(client.auth, 'oauthNativeSignIn', provider, await signed(true));
        expect(first).toMatchObject({ success: true });
        const [created] = await fixture.db.select().from(users).where(eq(users.email, createdEmail));
        expect(created).toBeDefined();
        const firstJwt = (await callRecorded(client.store, 'getAuthToken')) as string;
        expect((await jwtVerify(firstJwt, new TextEncoder().encode(process.env.NEXTAUTH_SECRET))).payload.sub).toBe(
          created.id,
        );
        const returning = await callRecorded(client.auth, 'oauthNativeSignIn', provider, await signed(false));
        expect(returning).toMatchObject({ success: true });
        expect(
          (
            await jwtVerify(
              (await callRecorded(client.store, 'getAuthToken')) as string,
              new TextEncoder().encode(process.env.NEXTAUTH_SECRET),
            )
          ).payload.sub,
        ).toBe(created.id);
        if (release.version === '2.6.0' || release.version === '2.7.0') {
          expect(first).toMatchObject({
            userId: created.id,
            accountCreation: { userId: created.id, accountCreated: true, provider },
          });
          expect(returning).toMatchObject({
            userId: created.id,
            accountCreation: { userId: created.id, accountCreated: false, provider },
          });
        }
      });
    }
  }

  for (const release of recordings.releases.filter((entry) => ['2.2.0', '2.3.0', '2.7.0'].includes(entry.version))) {
    it(`a lost successful refresh reply cannot reuse its consumed secret: ${release.tag}`, async () => {
      let dropReply = true;
      let discardedPair: Pair | undefined;
      let forcedSignOuts = 0;
      const client = await createReleasedClient(release, {
        fetch: async (input, init) => {
          const path = new URL(input instanceof Request ? input.url : input).pathname;
          if (path === '/protected') return Response.json({}, { status: 401 });
          const response = await fixture.network(input, init);
          if (path === '/auth/native/refresh' && dropReply) {
            dropReply = false;
            expect(response.status).toBe(200);
            discardedPair = (await response.json()) as Pair;
            throw new TypeError('Synthetic response lost after committed rotation');
          }
          return response;
        },
      });
      await callRecorded(client.auth, 'signInWithCredentials', email, password);
      const originalRefresh = await callRecorded(client.store, 'getRefreshToken');
      await callRecorded(client.interceptor, 'setOnForcedSignOut', () => {
        forcedSignOuts += 1;
      });
      const lost = await callRecorded(client.interceptor, 'deduplicatedRefresh');
      expect(typeof lost === 'boolean' ? lost : (lost as { status: string }).status === 'refreshed').toBe(false);
      expect(discardedPair?.refreshToken).not.toBe(originalRefresh);
      expect(await callRecorded(client.store, 'getRefreshToken')).toBe(originalRefresh);
      expect(forcedSignOuts).toBe(0);
      const retry = (await callRecorded(
        client.interceptor,
        'authenticatedFetch',
        'https://fixture.test/protected',
      )) as Response;
      expect(retry.status).toBe(401);
      expect(forcedSignOuts).toBe(1);
      expect(await callRecorded(client.store, 'getAuthToken')).toBeNull();
      expect(await callRecorded(client.store, 'getRefreshToken')).toBeNull();
    });
  }

  for (const path of [
    '/auth/native/credentials',
    '/auth/native/register',
    '/auth/native/oauth',
    '/auth/native/exchange',
    '/auth/native/refresh',
    '/auth/native/revoke',
    '/api/watch/pair-code',
    '/api/watch/pair',
  ]) {
    it(`mounted ${path} retains POST-only status and error JSON`, async () => {
      const response = await fixture.network(`${fixture.origin}${path}`, { method: 'GET' });
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: 'Method not allowed' });
    });
  }
  it('mounted malformed refresh and unknown refresh remain distinct failures', async () => {
    expect((await fixture.post('/auth/native/refresh', {})).status).toBe(400);
    const unknown = await fixture.post('/auth/native/refresh', { refreshToken: 'synthetic-unknown-refresh' });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: 'Invalid refresh token' });
  });
  it('mounted refresh rate-limit/overload stay 429/503 with retry information', async () => {
    for (let requestIndex = 0; requestIndex < 10; requestIndex += 1) {
      expect(
        (await fixture.post('/auth/native/refresh', { refreshToken: 'synthetic-rate-limit-refresh' })).status,
      ).toBe(401);
    }
    const limited = await fixture.post('/auth/native/refresh', { refreshToken: 'synthetic-rate-limit-refresh' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({
      error: expect.stringMatching(/^Rate limit exceeded\. Try again in /),
    });
    fixture.native.__resetNativeAuthStateForTests();
    // N2 separates refresh capacity from other auth requests. The recorded
    // contracts also run on pre-N2 handlers, which expose only the older helper.
    const versionedFixtures = fixture.native as typeof fixture.native & {
      readonly __fillRefreshRateLimitMapForTests?: typeof fixture.native.__fillRateLimitMapForTests;
    };
    const fillRefreshCapacity =
      versionedFixtures.__fillRefreshRateLimitMapForTests ?? versionedFixtures.__fillRateLimitMapForTests;
    fillRefreshCapacity(50_000);
    const overloaded = await fixture.post('/auth/native/refresh', { refreshToken: 'synthetic-overloaded-refresh' });
    expect(overloaded.status).toBe(503);
    expect(await overloaded.json()).toEqual({ error: 'Service temporarily overloaded' });
  });
  it('actual revoke retires same-account refresh credentials and replay stays rejected', async () => {
    const first = (await (await fixture.post('/auth/native/credentials', { email, password })).json()) as Pair;
    const sibling = (await (await fixture.post('/auth/native/credentials', { email, password })).json()) as Pair;
    const revoked = await fixture.post('/auth/native/revoke', { refreshToken: first.refreshToken });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true });
    expect((await fixture.post('/auth/native/refresh', { refreshToken: sibling.refreshToken })).status).toBe(401);
    expect((await fixture.post('/auth/native/revoke', { refreshToken: first.refreshToken })).status).toBe(401);
  });
  it('a pairing code that expires in Redis is rejected without issuing tokens', async () => {
    const pair = (await (await fixture.post('/auth/native/credentials', { email, password })).json()) as Pair;
    const issued = (await (await fixture.post('/api/watch/pair-code', {}, pair.jwt)).json()) as { code: string };
    await fixture.redis.getClients().publisher.expire(`boardsesh:watch:pair:${issued.code}`, 0);
    expect((await fixture.post('/api/watch/pair', { code: issued.code })).status).toBe(401);
  });

  it('exchanges one opaque browser return once across actual HTTP requests', async () => {
    const release = recordings.releases[0];
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({ userId: ownerId, iat: now, exp: now + 120, nextPath: `/${randomUUID()}` }),
    ).toString('base64url');
    const signature = createHmac('sha256', process.env.NEXTAUTH_SECRET!).update(payload).digest('base64url');
    const transferToken = `${payload}.${signature}`;
    let browserStartPath: string | undefined;
    const client = await createReleasedClient(release, {
      fetch: fixture.network,
      browserReturn: async (startUrl) => {
        browserStartPath = new URL(startUrl).pathname;
        return `com.boardsesh.app://auth/callback?transferToken=${encodeURIComponent(transferToken)}`;
      },
    });
    expect(await callRecorded(client.auth, 'signInWithGoogleWeb')).toMatchObject({ success: true });
    const replay = await fixture.post('/auth/native/exchange', { transferToken });
    expect(replay.status).toBe(409);
    expect(fixture.requests[0]).toMatchObject({ path: '/auth/native/exchange', body: { transferToken } });
    expect(fixture.requests[0].path).toBe(NATIVE_V1_PATHS.exchange);
    expect(browserStartPath).toBe(NATIVE_V1_PATHS.browserStart);
  });

  it('pairs once through Redis and persists a refresh credential for that account', async () => {
    const signedIn = await fixture.post('/auth/native/credentials', { email, password });
    const pair = (await signedIn.json()) as Pair;
    const issued = await fixture.post('/api/watch/pair-code', {}, pair.jwt);
    expect(issued.status).toBe(200);
    expect(fixture.requests.at(-1)?.path).toBe(NATIVE_V1_PATHS.watchPairCode);
    const codeReply = (await issued.json()) as { code: string; expiresAt: string };
    expect(codeReply.code).toMatch(/^[A-Z0-9]{8}$/);
    const key = `boardsesh:watch:pair:${codeReply.code}`;
    expect(await fixture.redis.getClients().publisher.get(key)).toBe(ownerId);
    expect(await fixture.redis.getClients().publisher.ttl(key)).toBeGreaterThan(290);
    const paired = await fixture.post('/api/watch/pair', { code: codeReply.code });
    expect(paired.status).toBe(200);
    expect(fixture.requests.at(-1)?.path).toBe(NATIVE_V1_PATHS.watchPair);
    await assertPair((await paired.json()) as Pair);
    expect(await fixture.redis.getClients().publisher.get(key)).toBeNull();
    expect((await fixture.post('/api/watch/pair', { code: codeReply.code })).status).toBe(401);
  });
});
