import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { AccountCreationReceipt } from '@boardsesh/analytics';
import { hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
const webRequire = createRequire(new URL('../../../../../web/package.json', import.meta.url));
vi.doMock(webRequire.resolve('server-only'), () => ({}));
import { createPrototypeEnvironment } from '../environment';
import { createPrototypeNativeFacade } from '../identity-native-facade';
import { createPrototypeLegacyHandler } from '../legacy-bridge';
import { createPrototypeLegacyTransferFacade, verifyPrototypeLegacyTransfer } from '../legacy-transfer';
import { PROTOTYPE_ISSUER } from '../oauth-options';
import { assertLegacyNativeTokenPair } from './identity-native-contract';
import * as releasedIssuer from './fixtures/native-oauth-issuer-main-5440';

const verificationSecret = 'boardsesh-synthetic-transfer-hmac-6975';
const nativeKey = new TextEncoder().encode('boardsesh-synthetic-transfer-native-6975');
const password = 'synthetic-transfer-password';
const attemptId = '0123456789abcdef0123456789abcdef';
const issuerPath = fileURLToPath(new URL('../../../../../web/app/lib/auth/native-oauth-transfer.ts', import.meta.url));

interface LegacyIssuer {
  issueNativeOAuthTransferToken(input: {
    userId: string;
    nextPath: string;
    accountCreation?: AccountCreationReceipt;
    authSessionId?: string;
    attemptId?: string;
    provider?: 'apple' | 'google';
  }): string;
  issueNativeOAuthAttempt(input: { attemptId: string; provider: 'apple' | 'google' }): string;
}

function sign(payload: unknown, secret = verificationSecret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}

function payload(userId: string = randomUUID(), additions: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { userId, nextPath: '/settings', iat: now, exp: now + 120, ...additions };
}

// Historical no-receipt transfers omitted their source SID and authentication
// age. Sign that exact wire shape instead of asking the corrected live issuer.
function historicalIdentifierStrippedTransfer(userId: string, nextPath = '/') {
  return sign(payload(userId, { nextPath }));
}

function lineageId(userId: string, authSessionId: string) {
  return `session:${createHash('sha256')
    .update(JSON.stringify(['nextauth-v4', userId, authSessionId]))
    .digest('hex')}`;
}

function receipt(userId: string): AccountCreationReceipt {
  return { userId, accountCreated: true, provider: 'google', createdAt: new Date().toISOString() };
}

describe('released browser-native transfer transport', () => {
  let issuer: LegacyIssuer;

  beforeAll(async () => {
    vi.stubEnv('NEXTAUTH_SECRET', verificationSecret);
    // Freeze the released producer; the corrected live issuer is checked below.
    issuer = releasedIssuer;
  });

  afterAll(() => vi.unstubAllEnvs());

  it('accepts the frozen released issuer with its two-part format and 120-second lifetime', () => {
    const userId = randomUUID();
    const token = issuer.issueNativeOAuthTransferToken({ userId, nextPath: '/settings' });
    expect(token.split('.')).toHaveLength(2);
    const proof = verifyPrototypeLegacyTransfer(token, verificationSecret);
    expect(proof).toMatchObject({ userId, nextPath: '/settings', authSessionId: null, originalAuthenticatedAt: null });
    expect(proof!.expiresAt.getTime() - proof!.issuedAt.getTime()).toBe(120_000);
    expect(proof!.validUntil.getTime() - proof!.expiresAt.getTime()).toBe(6000);
  });

  it('the corrected live issuer preserves a returning session without creation metadata', async () => {
    const liveIssuer = await vi.importActual<LegacyIssuer>(issuerPath);
    const userId = randomUUID();
    const token = liveIssuer.issueNativeOAuthTransferToken({ userId, nextPath: '/', authSessionId: 'browser' });
    expect(verifyPrototypeLegacyTransfer(token, verificationSecret)).toMatchObject({
      userId,
      authSessionId: 'browser',
      originalAuthenticatedAt: null,
    });
  });

  it('records the released issuer dropping a returning browser session identifier without creation proof', () => {
    const token = issuer.issueNativeOAuthTransferToken({
      userId: randomUUID(),
      nextPath: '/',
      authSessionId: 'browser',
    });
    expect(verifyPrototypeLegacyTransfer(token, verificationSecret)?.authSessionId).toBeNull();
  });

  it('accepts the historical signed identifier-stripped wire shape without inventing age', () => {
    const userId = randomUUID();
    const proof = verifyPrototypeLegacyTransfer(historicalIdentifierStrippedTransfer(userId), verificationSecret);
    expect(proof).toMatchObject({ userId, authSessionId: null, originalAuthenticatedAt: null });
    expect(proof?.accountCreation).toBeUndefined();
  });

  it('accepts signed creation metadata only with its immutable user, provider, session and attempt binding', () => {
    const userId = randomUUID();
    const accountCreation = receipt(userId);
    const token = issuer.issueNativeOAuthTransferToken({
      userId,
      nextPath: '/',
      accountCreation,
      authSessionId: 'browser',
      attemptId,
      provider: 'google',
    });
    expect(verifyPrototypeLegacyTransfer(token, verificationSecret)).toMatchObject({
      userId,
      accountCreation,
      authSessionId: 'browser',
      attemptId,
      provider: 'google',
      originalAuthenticatedAt: null,
    });
  });

  it.each(['foreign-user', 'foreign-provider', 'missing-attempt', 'missing-session', 'malformed-receipt'] as const)(
    'strips optional %s creation metadata while preserving verified sign-in',
    (failure) => {
      const userId = randomUUID();
      const candidate: Record<string, unknown> = payload(userId, {
        accountCreation: receipt(failure === 'foreign-user' ? randomUUID() : userId),
        provider: failure === 'foreign-provider' ? 'apple' : 'google',
        attemptId: failure === 'missing-attempt' ? undefined : attemptId,
        authSessionId: failure === 'missing-session' ? undefined : 'browser',
      });
      if (failure === 'malformed-receipt') candidate.accountCreation = { ...receipt(userId), createdAt: 'yesterday' };
      const proof = verifyPrototypeLegacyTransfer(sign(candidate), verificationSecret);
      expect(proof?.userId).toBe(userId);
      expect(proof?.accountCreation).toBeUndefined();
    },
  );

  it.each(['userId', 'attemptId', 'accountCreation'] as const)('rejects tampering with signed %s', (field) => {
    const userId = randomUUID();
    const token = issuer.issueNativeOAuthTransferToken({
      userId,
      nextPath: '/',
      accountCreation: receipt(userId),
      authSessionId: 'browser',
      attemptId,
      provider: 'google',
    });
    const [encoded, signature] = token.split('.');
    const changed = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as Record<string, unknown>;
    changed[field] = field === 'accountCreation' ? receipt(randomUUID()) : randomUUID();
    expect(
      verifyPrototypeLegacyTransfer(
        `${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${signature}`,
        verificationSecret,
      ),
    ).toBeNull();
  });

  it('rejects the real same-secret OAuth attempt cookie and standalone account-creation receipt', () => {
    expect(
      verifyPrototypeLegacyTransfer(
        issuer.issueNativeOAuthAttempt({ attemptId, provider: 'google' }),
        verificationSecret,
      ),
    ).toBeNull();
    expect(verifyPrototypeLegacyTransfer(sign(receipt(randomUUID())), verificationSecret)).toBeNull();
  });

  it.each(['kind', 'purpose', 'token_use', 'iss', 'aud'])(
    'rejects same-secret sibling messages labelled %s',
    (field) => {
      expect(
        verifyPrototypeLegacyTransfer(
          sign(payload(undefined, { [field]: 'native-oauth-attempt' })),
          verificationSecret,
        ),
      ).toBeNull();
    },
  );

  it.each([undefined, null, 42, {}, '', 'one.two.three', 'not-json.signature', 'x'.repeat(4097)])(
    'rejects malformed transport %j',
    (token) => {
      expect(verifyPrototypeLegacyTransfer(token, verificationSecret)).toBeNull();
    },
  );

  it.each([null, [], true, 'scalar', { userId: 'user' }])('rejects signed non-transfer JSON %j', (candidate) => {
    expect(verifyPrototypeLegacyTransfer(sign(candidate), verificationSecret)).toBeNull();
  });

  it('rejects an incorrect key and noncanonical base64 signature aliases', () => {
    const token = sign(payload());
    expect(verifyPrototypeLegacyTransfer(token, 'different-synthetic-secret')).toBeNull();
    const [encoded, signature] = token.split('.');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const finalIndex = alphabet.indexOf(signature.at(-1)!);
    const alias = `${signature.slice(0, -1)}${alphabet[finalIndex + 1]}`;
    expect(Buffer.from(alias, 'base64url')).toEqual(Buffer.from(signature, 'base64url'));
    expect(verifyPrototypeLegacyTransfer(`${encoded}.${alias}`, verificationSecret)).toBeNull();
  });

  it('preserves the inclusive final grace second without allowing later cleanup to reopen replay', () => {
    const candidate = payload();
    const token = sign(candidate);
    expect(
      verifyPrototypeLegacyTransfer(token, verificationSecret, new Date((candidate.exp + 5) * 1000 + 999)),
    ).not.toBeNull();
    expect(verifyPrototypeLegacyTransfer(token, verificationSecret, new Date((candidate.exp + 6) * 1000))).toBeNull();
  });

  it('permits five seconds of producer clock lead and caps signed lifetime at 125 seconds', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      verifyPrototypeLegacyTransfer(sign(payload(undefined, { iat: now + 5, exp: now + 130 })), verificationSecret),
    ).not.toBeNull();
    expect(
      verifyPrototypeLegacyTransfer(sign(payload(undefined, { iat: now + 6, exp: now + 126 })), verificationSecret),
    ).toBeNull();
    expect(verifyPrototypeLegacyTransfer(sign(payload(undefined, { exp: now + 126 })), verificationSecret)).toBeNull();
  });

  it.each([
    { iat: '100' },
    { exp: '200' },
    { iat: 0 },
    { iat: 1.5 },
    { exp: Number.MAX_SAFE_INTEGER },
    { userId: '' },
    { nextPath: undefined },
    { nextPath: '' },
    { nextPath: 42 },
  ])('rejects malformed signed claims %j', (claims) => {
    expect(verifyPrototypeLegacyTransfer(sign(payload(undefined, claims)), verificationSecret)).toBeNull();
  });

  it.each(['//external.example', '/\\external.example', '/\nsettings', 'https://external.example'])(
    'normalizes unsafe callback path %j',
    (nextPath) => {
      expect(verifyPrototypeLegacyTransfer(sign(payload(undefined, { nextPath })), verificationSecret)?.nextPath).toBe(
        '/',
      );
    },
  );

  it('never treats handoff iat, supplied auth_time or account creation as a fresh login', () => {
    const userId = randomUUID();
    expect(
      verifyPrototypeLegacyTransfer(
        sign(
          payload(userId, {
            auth_time: Math.floor(Date.now() / 1000),
            accountCreation: receipt(userId),
            authSessionId: 'browser',
            attemptId,
            provider: 'google',
          }),
        ),
        verificationSecret,
      )?.originalAuthenticatedAt,
    ).toBeNull();
  });
});

describe('durable transfer redemption and the canonical native authority', () => {
  let environment: Awaited<ReturnType<typeof createPrototypeEnvironment>>;
  let issuer: LegacyIssuer;
  let first: ReturnType<typeof createPrototypeLegacyTransferFacade>;
  let second: ReturnType<typeof createPrototypeLegacyTransferFacade>;
  let native: ReturnType<typeof createPrototypeNativeFacade>;
  let passwordHash: string;

  beforeAll(async () => {
    vi.stubEnv('NEXTAUTH_SECRET', verificationSecret);
    issuer = releasedIssuer;
    environment = await createPrototypeEnvironment();
    passwordHash = await hash(password, 4);
    first = createPrototypeLegacyTransferFacade(environment.database, verificationSecret, nativeKey);
    second = createPrototypeLegacyTransferFacade(environment.database, verificationSecret, nativeKey);
    native = createPrototypeNativeFacade(environment.database, nativeKey);
  });

  afterAll(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await environment?.close();
  });

  async function fixture() {
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    await environment.database.insert(environment.schema.user).values({ id: userId, email, name: 'Transfer fixture' });
    await environment.database.insert(environment.schema.account).values({
      id: randomUUID(),
      userId,
      accountId: userId,
      providerId: 'credential',
      password: passwordHash,
    });
    const token = issuer.issueNativeOAuthTransferToken({ userId, nextPath: '/settings' });
    return { userId, email, token };
  }

  async function mappedFixture(originalAuthenticatedAt: Date | null = new Date(Date.now() - 86_400_000)) {
    const user = await fixture();
    const authSessionId = randomUUID();
    const sessionId = randomUUID();
    const mappedLineageId = lineageId(user.userId, authSessionId);
    await environment.database.insert(environment.schema.session).values({
      id: sessionId,
      userId: user.userId,
      token: randomUUID(),
      createdAt: originalAuthenticatedAt ?? new Date(0),
      updatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      originalAuthenticatedAt,
      legacyLineageId: mappedLineageId,
    });
    await environment.database.insert(environment.schema.prototypeLegacyLineage).values({
      id: mappedLineageId,
      userId: user.userId,
      sessionId,
      originalAuthenticatedAt,
      originalExpiresAt: new Date(Date.now() + 60_000),
    });
    const token = issuer.issueNativeOAuthTransferToken({
      userId: user.userId,
      nextPath: '/',
      authSessionId,
      accountCreation: receipt(user.userId),
      attemptId,
      provider: 'google',
    });
    return { ...user, authSessionId, sessionId, mappedLineageId, token };
  }

  async function resetPassword(userId: string) {
    const resetToken = randomUUID();
    await environment.database.insert(environment.schema.verification).values({
      id: randomUUID(),
      identifier: `reset-password:${resetToken}`,
      value: userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return createPrototypeLegacyHandler(environment.database)(
      new Request(`${PROTOTYPE_ISSUER}/reset-password`, {
        method: 'POST',
        headers: { origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword: 'changed-transfer-fixture-password' }),
      }),
    );
  }

  async function storedFor(userId: string) {
    const [sessions, refreshes, lineages, markers] = await Promise.all([
      environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, userId)),
      environment.database
        .select()
        .from(environment.schema.prototypeNativeRefresh)
        .where(eq(environment.schema.prototypeNativeRefresh.userId, userId)),
      environment.database
        .select()
        .from(environment.schema.prototypeLegacyLineage)
        .where(eq(environment.schema.prototypeLegacyLineage.userId, userId)),
      environment.database.select().from(environment.schema.verification),
    ]);
    return { sessions, refreshes, lineages, markers: markers.filter((marker) => marker.value.includes(userId)) };
  }

  it('exchanges the actual released basic issuer for the unchanged native pair without inventing auth age', async () => {
    const user = await fixture();
    const pair = await second.exchange(user.token);
    const claims = await assertLegacyNativeTokenPair(pair, nativeKey, user.userId);
    expect(claims.auth_time).toBeUndefined();
    const stored = await storedFor(user.userId);
    expect(stored.sessions).toHaveLength(1);
    expect(stored.sessions[0].createdAt).toEqual(new Date(0));
    expect(stored.sessions[0].originalAuthenticatedAt).toBeNull();
    expect(stored.refreshes).toHaveLength(1);
    expect(stored.refreshes[0].tokenHash).toBe(createHash('sha256').update(pair.refreshToken).digest('hex'));
    expect(stored.refreshes[0].expiresAt.getTime() - stored.refreshes[0].createdAt.getTime()).toBe(90 * 86_400_000);
    expect(stored.markers).toHaveLength(1);
    expect(stored.markers[0].expiresAt).toEqual(
      verifyPrototypeLegacyTransfer(user.token, verificationSecret)?.validUntil,
    );
    expect(stored.markers[0].value).not.toContain(user.token);
    expect(stored.markers[0].value).not.toContain(user.token.split('.')[1]);
  });

  it('allows one concurrent redemption across independent facades and rejects replay after handler recreation', async () => {
    const user = await fixture();
    const outcomes = await Promise.allSettled([first.exchange(user.token), second.exchange(user.token)]);
    const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (accepted[0].status !== 'fulfilled' || rejected[0].status !== 'rejected')
      throw new Error('Expected one transfer winner');
    await assertLegacyNativeTokenPair(accepted[0].value, nativeKey, user.userId);
    expect(rejected[0].reason).toMatchObject({ status: 409 });
    await expect(
      createPrototypeLegacyTransferFacade(environment.database, verificationSecret, nativeKey).exchange(user.token),
    ).rejects.toMatchObject({ status: 409 });
    expect((await storedFor(user.userId)).refreshes).toHaveLength(1);
  });

  it('cannot redeem a token again after a successful response is lost', async () => {
    const user = await fixture();
    const pair = await first.exchange(user.token);
    await assertLegacyNativeTokenPair(pair, nativeKey, user.userId);
    await expect(second.exchange(user.token)).rejects.toMatchObject({ status: 409 });
    expect(await native.validateAccessToken(pair.jwt)).toMatchObject({ userId: user.userId });
  });

  it.each([new Date(Date.now() - 86_400_000), null])(
    'reuses a verified same-owner web lineage retaining original age %j',
    async (originalAuthenticatedAt) => {
      const user = await mappedFixture(originalAuthenticatedAt);
      const pair = await first.exchange(user.token);
      const claims = await assertLegacyNativeTokenPair(pair, nativeKey, user.userId);
      expect(claims.sid).toBe(user.sessionId);
      expect(claims.auth_time).toBe(
        originalAuthenticatedAt ? Math.floor(originalAuthenticatedAt.getTime() / 1000) : undefined,
      );
      expect(pair).toHaveProperty('accountCreation.userId', user.userId);
      expect((await storedFor(user.userId)).sessions).toHaveLength(1);
    },
  );

  it('rejects a lineage hash whose stored owner differs from the signed source user', async () => {
    const user = await mappedFixture();
    const other = await fixture();
    await environment.database
      .update(environment.schema.prototypeLegacyLineage)
      .set({ userId: other.userId })
      .where(eq(environment.schema.prototypeLegacyLineage.id, user.mappedLineageId));
    await expect(first.exchange(user.token)).rejects.toMatchObject({ status: 401 });
    expect((await storedFor(user.userId)).refreshes).toHaveLength(0);
  });

  it.each(['revoked', 'missing-session', 'expired-session'] as const)(
    'rejects a known %s source lineage',
    async (failure) => {
      const user = await mappedFixture();
      if (failure === 'revoked') {
        await environment.database
          .update(environment.schema.prototypeLegacyLineage)
          .set({ revokedAt: new Date() })
          .where(eq(environment.schema.prototypeLegacyLineage.id, user.mappedLineageId));
      } else if (failure === 'missing-session') {
        await environment.database
          .delete(environment.schema.session)
          .where(eq(environment.schema.session.id, user.sessionId));
      } else {
        await environment.database
          .update(environment.schema.session)
          .set({ expiresAt: new Date(0) })
          .where(eq(environment.schema.session.id, user.sessionId));
      }
      await expect(second.exchange(user.token)).rejects.toMatchObject({ status: 401 });
      expect((await storedFor(user.userId)).refreshes).toHaveLength(0);
    },
  );

  it.each(['revoked', 'missing-session', 'expired-session'] as const)(
    'blocks an identifier-stripped returning transfer after prior %s lineage',
    async (failure) => {
      const user = await mappedFixture();
      if (failure === 'revoked') {
        await environment.database
          .update(environment.schema.prototypeLegacyLineage)
          .set({ revokedAt: new Date() })
          .where(eq(environment.schema.prototypeLegacyLineage.id, user.mappedLineageId));
      } else if (failure === 'missing-session') {
        await environment.database
          .delete(environment.schema.session)
          .where(eq(environment.schema.session.id, user.sessionId));
      } else {
        await environment.database
          .update(environment.schema.session)
          .set({ expiresAt: new Date(0) })
          .where(eq(environment.schema.session.id, user.sessionId));
      }
      const ambiguousToken = historicalIdentifierStrippedTransfer(user.userId);
      expect(verifyPrototypeLegacyTransfer(ambiguousToken, verificationSecret)?.authSessionId).toBeNull();
      await expect(second.exchange(ambiguousToken)).rejects.toMatchObject({ status: 401 });
    },
  );

  it('rejects a deleted canonical user and never consumes their token', async () => {
    const user = await fixture();
    await environment.database.delete(environment.schema.user).where(eq(environment.schema.user.id, user.userId));
    await expect(first.exchange(user.token)).rejects.toMatchObject({ status: 401 });
    expect((await storedFor(user.userId)).markers).toHaveLength(0);
  });

  it('ordinary native signout blocks unused same-source and identifier-stripped transfers without affecting another user', async () => {
    const user = await mappedFixture();
    const unrelated = await fixture();
    const pair = await first.exchange(user.token);
    const unusedSameSource = issuer.issueNativeOAuthTransferToken({
      userId: user.userId,
      nextPath: '/different-path',
      authSessionId: user.authSessionId,
      accountCreation: receipt(user.userId),
      attemptId,
      provider: 'google',
    });
    const unusedUnknownSource = historicalIdentifierStrippedTransfer(user.userId, '/different-path');
    expect(verifyPrototypeLegacyTransfer(unusedUnknownSource, verificationSecret)?.authSessionId).toBeNull();
    await native.revoke(pair.refreshToken);
    await expect(second.exchange(unusedSameSource)).rejects.toMatchObject({ status: 401 });
    await expect(second.exchange(unusedUnknownSource)).rejects.toMatchObject({ status: 401 });
    expect((await storedFor(user.userId)).refreshes).toHaveLength(0);
    await assertLegacyNativeTokenPair(await second.exchange(unrelated.token), nativeKey, unrelated.userId);
  });

  it('rejects a canonical source session owned by another account', async () => {
    const user = await mappedFixture();
    const other = await fixture();
    await environment.database
      .update(environment.schema.session)
      .set({ userId: other.userId })
      .where(eq(environment.schema.session.id, user.sessionId));
    await expect(first.exchange(user.token)).rejects.toMatchObject({ status: 401 });
    expect((await storedFor(user.userId)).refreshes).toHaveLength(0);
  });

  it('canonical browser signout blocks unknown transfers but preserves another mapped native session', async () => {
    const user = await mappedFixture();
    const mappedPair = await first.exchange(user.token);
    const handler = createPrototypeLegacyHandler(environment.database);
    const signIn = await handler(
      new Request(`${PROTOTYPE_ISSUER}/sign-in/email`, {
        method: 'POST',
        headers: { origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
        body: JSON.stringify({ email: user.email, password }),
      }),
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers
      .getSetCookie()
      .find((header) => header.includes('better-auth.session_token='))
      ?.split(';')[0];
    expect(cookie).toBeDefined();
    const signOut = await handler(
      new Request(`${PROTOTYPE_ISSUER}/sign-out`, {
        method: 'POST',
        headers: { cookie: cookie!, origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(signOut.status).toBe(200);
    const sourceLess = issuer.issueNativeOAuthTransferToken({ userId: user.userId, nextPath: '/after-signout' });
    const restarted = createPrototypeLegacyTransferFacade(environment.database, verificationSecret, nativeKey);
    await expect(restarted.exchange(sourceLess)).rejects.toMatchObject({ status: 401 });
    expect(await native.validateAccessToken(mappedPair.jwt)).toMatchObject({ userId: user.userId });
    await assertLegacyNativeTokenPair(await native.refresh(mappedPair.refreshToken), nativeKey, user.userId);
    const sameMappedSource = issuer.issueNativeOAuthTransferToken({
      userId: user.userId,
      nextPath: '/known-source',
      authSessionId: user.authSessionId,
      accountCreation: receipt(user.userId),
      attemptId,
      provider: 'google',
    });
    await assertLegacyNativeTokenPair(await restarted.exchange(sameMappedSource), nativeKey, user.userId);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, user.userId)),
    ).toEqual([]);
  });

  it('the shared native issuer checks the canonical cutoff for a known lineage', async () => {
    const user = await mappedFixture();
    await environment.database.insert(environment.schema.prototypeUserCutoff).values({
      userId: user.userId,
      revokedThrough: new Date(),
    });
    await expect(first.exchange(user.token)).rejects.toMatchObject({ status: 401 });
    expect((await storedFor(user.userId)).markers).toHaveLength(0);
  });

  it('a recent handoff minted after reset cannot turn stale browser provenance into new authentication', async () => {
    const user = await fixture();
    expect((await resetPassword(user.userId)).status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 10_000);
      const recentToken = issuer.issueNativeOAuthTransferToken({ userId: user.userId, nextPath: '/' });
      const [cutoff] = await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, user.userId));
      expect(verifyPrototypeLegacyTransfer(recentToken, verificationSecret)!.issuedAt.getTime()).toBeGreaterThan(
        cutoff.revokedThrough.getTime(),
      );
      await expect(second.exchange(recentToken)).rejects.toMatchObject({ status: 401 });
    } finally {
      vi.useRealTimers();
    }
    expect((await storedFor(user.userId)).refreshes).toHaveLength(0);
  });

  it.each(['reset-first', 'exchange-first'] as const)(
    'actual password reset racing exchange leaves no valid descendants (request start order: %s)',
    async (order) => {
      const user = await fixture();
      const reset = () => resetPassword(user.userId);
      const exchange = () => second.exchange(user.token);
      const outcomes =
        order === 'reset-first'
          ? await Promise.allSettled([reset(), exchange()])
          : await Promise.allSettled([exchange(), reset()]);
      const [resetOutcome, exchangeOutcome] = order === 'reset-first' ? outcomes : [outcomes[1], outcomes[0]];
      expect(resetOutcome.status).toBe('fulfilled');
      if (resetOutcome.status === 'fulfilled' && resetOutcome.value instanceof Response)
        expect(resetOutcome.value.status).toBe(200);
      if (exchangeOutcome.status === 'fulfilled' && 'jwt' in exchangeOutcome.value) {
        expect(await native.validateAccessToken(exchangeOutcome.value.jwt)).toBeNull();
        await expect(native.refresh(exchangeOutcome.value.refreshToken)).rejects.toMatchObject({ status: 401 });
      }
      expect((await storedFor(user.userId)).refreshes).toHaveLength(0);
      await expect(first.exchange(user.token)).rejects.toMatchObject({ status: expect.toBeOneOf([401, 409]) });
    },
  );

  it('a pair minted before reset remains revoked when its successful response arrives later', async () => {
    const user = await fixture();
    const completed = await first.exchange(user.token);
    expect((await resetPassword(user.userId)).status).toBe(200);
    const delayedResponse = Promise.resolve(completed);
    const latePair = await delayedResponse;
    await assertLegacyNativeTokenPair(latePair, nativeKey, user.userId);
    expect(await native.validateAccessToken(latePair.jwt)).toBeNull();
    await expect(native.refresh(latePair.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it('rolls back durable consumption, lineage, canonical session and real native mint when the enclosing callback fails', async () => {
    const user = await fixture();
    let observedRealMint = false;
    const failing = createPrototypeLegacyTransferFacade(
      environment.database,
      verificationSecret,
      nativeKey,
      async () => {
        observedRealMint = true;
        throw new Error('synthetic post-mint transaction failure');
      },
    );
    await expect(failing.exchange(user.token)).rejects.toThrow('synthetic post-mint transaction failure');
    expect(observedRealMint).toBe(true);
    expect(await storedFor(user.userId)).toEqual({ sessions: [], refreshes: [], lineages: [], markers: [] });
    await assertLegacyNativeTokenPair(await second.exchange(user.token), nativeKey, user.userId);
  });

  it('rolls back an existing canonical session expiry extension when native issuance callback fails', async () => {
    const user = await mappedFixture();
    const [before] = (await storedFor(user.userId)).sessions;
    const failing = createPrototypeLegacyTransferFacade(
      environment.database,
      verificationSecret,
      nativeKey,
      async () => {
        throw new Error('synthetic existing-session transaction failure');
      },
    );
    await expect(failing.exchange(user.token)).rejects.toThrow('synthetic existing-session transaction failure');
    const stored = await storedFor(user.userId);
    expect(stored.sessions[0].expiresAt).toEqual(before.expiresAt);
    expect(stored.refreshes).toHaveLength(0);
    expect(stored.markers).toHaveLength(0);
    expect((await second.exchange(user.token)).userId).toBe(user.userId);
  });

  it('the trusted issuance transaction also rolls back caller cutoff metadata and consumption together', async () => {
    const user = await mappedFixture();
    const consumedId = `prototype-native-transfer:${randomUUID()}`;
    await expect(
      native.withIssuanceTransaction(async (transaction, issueForSession) => {
        await transaction.insert(environment.schema.verification).values({
          id: consumedId,
          identifier: consumedId,
          value: user.userId,
          expiresAt: new Date(Date.now() + 60_000),
        });
        await issueForSession(user.userId, user.sessionId);
        await transaction.insert(environment.schema.prototypeUserCutoff).values({
          userId: user.userId,
          revokedThrough: new Date(),
        });
        throw new Error('synthetic caller cutoff rollback');
      }),
    ).rejects.toThrow('synthetic caller cutoff rollback');
    expect((await storedFor(user.userId)).markers).toHaveLength(0);
    expect((await storedFor(user.userId)).refreshes).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, user.userId)),
    ).toHaveLength(0);
  });
});
