import { randomInt, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { makeSignature } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { createPrototypeNativeFacade } from '../identity-native-facade';
import { createPrototypeWatchFacade, PROTOTYPE_WATCH_CODE_ALPHABET } from '../identity-watch-facade';
import { createPrototypeLegacyHandler } from '../legacy-bridge';
import { createPrototypeLegacyWatchFacade } from '../legacy-watch';
import { PROTOTYPE_ISSUER } from '../oauth-options';
import { assertLegacyNativeTokenPair } from './identity-native-contract';

const nativeKey = new TextEncoder().encode('boardsesh-synthetic-legacy-watch-6975');
const password = 'synthetic-legacy-watch-password';
const namespace = `boardsesh:ba01:legacy-watch:${randomUUID()}:`;
const newNamespace = `boardsesh:ba01:watch:${randomUUID()}:`;

function redisClient() {
  const url = new URL(process.env.AUTH_PROTOTYPE_REDIS_URL ?? 'redis://127.0.0.1:6380');
  if (url.protocol !== 'redis:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.search)
    throw new Error('The legacy watch proof requires local Redis without URL options');
  const client = new Redis(url.toString(), {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 2000,
    commandTimeout: 2000,
  });
  client.on('error', () => {});
  return client;
}

function pendingCode() {
  return Array.from(
    { length: 8 },
    () => PROTOTYPE_WATCH_CODE_ALPHABET[randomInt(PROTOTYPE_WATCH_CODE_ALPHABET.length)],
  ).join('');
}

describe('pre-cutover raw user-ID Garmin pairing over real Redis', () => {
  let environment: Awaited<ReturnType<typeof createPrototypeEnvironment>>;
  let firstRedis: Redis;
  let secondRedis: Redis;
  let first: ReturnType<typeof createPrototypeLegacyWatchFacade>;
  let second: ReturnType<typeof createPrototypeLegacyWatchFacade>;
  let native: ReturnType<typeof createPrototypeNativeFacade>;
  let cutoverAt: Date;
  let passwordHash: string;

  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    firstRedis = redisClient();
    secondRedis = redisClient();
    await Promise.all([firstRedis.connect(), secondRedis.connect()]);
    passwordHash = await hash(password, 4);
    cutoverAt = new Date(Date.now() - 1000);
    first = createPrototypeLegacyWatchFacade(environment.database, nativeKey, firstRedis, namespace, cutoverAt);
    second = createPrototypeLegacyWatchFacade(environment.database, nativeKey, secondRedis, namespace, cutoverAt);
    native = createPrototypeNativeFacade(environment.database, nativeKey);
    // An unknown code registers the permanent cutover without minting a pair.
    await expect(first.consumePairingCode('IIIIIIII')).rejects.toMatchObject({ status: 401 });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      if (firstRedis?.status === 'ready') {
        for (const ownedPrefix of [namespace, newNamespace]) {
          const keys = await firstRedis.keys(`${ownedPrefix}*`);
          if (keys.length) await firstRedis.del(...keys);
        }
      }
    } finally {
      await Promise.allSettled(
        [firstRedis, secondRedis].map(async (client) => {
          try {
            if (client?.status === 'ready') await client.quit();
          } finally {
            client?.disconnect();
          }
        }),
      );
      await environment?.close();
    }
  });

  async function fixture() {
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    await environment.database
      .insert(environment.schema.user)
      .values({ id: userId, email, name: 'Legacy watch fixture' });
    await environment.database.insert(environment.schema.account).values({
      id: randomUUID(),
      userId,
      accountId: userId,
      providerId: 'credential',
      password: passwordHash,
    });
    return { userId, email };
  }

  async function pending(userId: string, milliseconds = 300_000) {
    const code = pendingCode();
    expect(await firstRedis.set(`${namespace}${code}`, userId, 'PX', milliseconds, 'NX')).toBe('OK');
    return code;
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
        body: JSON.stringify({ token: resetToken, newPassword: 'changed-legacy-watch-fixture-password' }),
      }),
    );
  }

  async function storedFor(userId: string) {
    const [sessions, refreshes, lineages] = await Promise.all([
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
    ]);
    return { sessions, refreshes, lineages };
  }

  it('consumes the released raw user-ID value and preserves the exact native pair with unknown authentication age', async () => {
    const user = await fixture();
    const code = await pending(user.userId);
    expect(await firstRedis.get(`${namespace}${code}`)).toBe(user.userId);
    expect(code.split('').every((character) => PROTOTYPE_WATCH_CODE_ALPHABET.includes(character))).toBe(true);
    const pair = await second.consumePairingCode(code);
    const claims = await assertLegacyNativeTokenPair(pair, nativeKey, user.userId);
    expect(claims.auth_time).toBeUndefined();
    expect(await firstRedis.pttl(`${namespace}${code}`)).toBe(-2);
    const stored = await storedFor(user.userId);
    expect(stored.sessions).toHaveLength(1);
    expect(stored.sessions[0].createdAt).toEqual(new Date(0));
    expect(stored.sessions[0].originalAuthenticatedAt).toBeNull();
    expect(stored.lineages[0].originalAuthenticatedAt).toBeNull();
    expect(stored.lineages[0].originalExpiresAt.getTime()).toBeLessThanOrEqual(cutoverAt.getTime() + 300_000);
    expect(stored.refreshes[0].expiresAt.getTime() - stored.refreshes[0].createdAt.getTime()).toBe(90 * 86_400_000);
  });

  it('retains only the actual remaining TTL instead of renewing a pending code for five minutes', async () => {
    const user = await fixture();
    const code = await pending(user.userId, 10_000);
    const before = Date.now();
    await first.consumePairingCode(code);
    const stored = await storedFor(user.userId);
    expect(stored.lineages[0].originalExpiresAt.getTime()).toBeGreaterThan(before + 9000);
    expect(stored.lineages[0].originalExpiresAt.getTime()).toBeLessThanOrEqual(before + 10_000);
    expect(await firstRedis.exists(`${namespace}${code}`)).toBe(0);
  });

  it('preserves released lowercase/separator normalization', async () => {
    const user = await fixture();
    const code = await pending(user.userId);
    const handEntry = ` ${code.slice(0, 4).toLowerCase()} - ${code.slice(4).toLowerCase()} `;
    expect((await first.consumePairingCode(handEntry)).userId).toBe(user.userId);
  });

  it('GETDEL permits one winner across two independent Redis clients and survives facade recreation', async () => {
    const user = await fixture();
    const code = await pending(user.userId);
    const outcomes = await Promise.allSettled([first.consumePairingCode(code), second.consumePairingCode(code)]);
    const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(accepted).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    if (accepted[0].status !== 'fulfilled') throw new Error('Expected one pending-code winner');
    await assertLegacyNativeTokenPair(accepted[0].value, nativeKey, user.userId);
    await expect(
      createPrototypeLegacyWatchFacade(
        environment.database,
        nativeKey,
        secondRedis,
        namespace,
        cutoverAt,
      ).consumePairingCode(code),
    ).rejects.toMatchObject({ status: 401 });
    expect((await storedFor(user.userId)).refreshes).toHaveLength(1);
  });

  it('a successful pair remains consumed when its response is lost', async () => {
    const user = await fixture();
    const code = await pending(user.userId);
    const minted = await first.consumePairingCode(code);
    await assertLegacyNativeTokenPair(minted, nativeKey, user.userId);
    await expect(second.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
    expect(await native.validateAccessToken(minted.jwt)).toMatchObject({ userId: user.userId });
  });

  it.each(['no-expiry', 'excessive-ttl', 'expired'] as const)(
    'rejects %s Redis state without native issuance',
    async (failure) => {
      const user = await fixture();
      const code = pendingCode();
      if (failure === 'no-expiry') await firstRedis.set(`${namespace}${code}`, user.userId);
      else if (failure === 'excessive-ttl') await firstRedis.set(`${namespace}${code}`, user.userId, 'PX', 301_000);
      else {
        await firstRedis.set(`${namespace}${code}`, user.userId, 'PX', 1);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await expect(first.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
      expect(await storedFor(user.userId)).toEqual({ sessions: [], refreshes: [], lineages: [] });
    },
  );

  it('rejects a code whose remaining lifetime ends while canonical issuance is waiting', async () => {
    const user = await fixture();
    const code = await pending(user.userId, 100);
    const delayed = createPrototypeLegacyWatchFacade(
      environment.database,
      nativeKey,
      firstRedis,
      namespace,
      cutoverAt,
      {
        afterConsume: async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
        },
      },
    );
    await expect(delayed.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
    expect(await firstRedis.exists(`${namespace}${code}`)).toBe(0);
    expect((await storedFor(user.userId)).refreshes).toHaveLength(0);
  });

  it.each([null, 42, {}, '', 'short', '123456789'])('rejects malformed hand entry %j', async (code) => {
    await expect(first.consumePairingCode(code)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects unknown codes and malformed raw values', async () => {
    await expect(first.consumePairingCode('IIIIIIII')).rejects.toMatchObject({ status: 401 });
    const code = pendingCode();
    await firstRedis.set(`${namespace}${code}`, 'not-a-user-id', 'EX', 300);
    await expect(first.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
  });

  it('new JSON session bindings remain accepted by the new facade and cannot be read as legacy raw IDs', async () => {
    const user = await fixture();
    const phone = await native.credentials(user.email, password);
    const currentWatch = createPrototypeWatchFacade(native, firstRedis, newNamespace);
    const issued = await currentWatch.createPairingCode(phone.jwt);
    const binding = await firstRedis.get(`${newNamespace}${issued.code}`);
    expect(binding).not.toBeNull();
    await firstRedis.set(`${namespace}${issued.code}`, binding!, 'EX', 300);
    await expect(first.consumePairingCode(issued.code)).rejects.toMatchObject({ status: 401 });
    const pair = await currentWatch.consumePairingCode(issued.code);
    expect(decodeJwt(pair.jwt).sid).toBe(decodeJwt(phone.jwt).sid);
    await assertLegacyNativeTokenPair(pair, nativeKey, user.userId);
    const rawCode = pendingCode();
    await firstRedis.set(`${newNamespace}${rawCode}`, user.userId, 'EX', 300);
    await expect(currentWatch.consumePairingCode(rawCode)).rejects.toMatchObject({ status: 401 });
  });

  it.each([
    'deleted-user',
    'account-cutoff',
    'revoked-lineage',
    'missing-session',
    'expired-session',
    'foreign-session-owner',
  ] as const)('rejects unknown-source pairing after %s', async (failure) => {
    const user = await fixture();
    const code = await pending(user.userId);
    if (failure === 'deleted-user') {
      await environment.database.delete(environment.schema.user).where(eq(environment.schema.user.id, user.userId));
    } else if (failure === 'account-cutoff') {
      await environment.database
        .insert(environment.schema.prototypeUserCutoff)
        .values({ userId: user.userId, revokedThrough: new Date() });
    } else {
      const sessionId = randomUUID();
      const legacyLineageId = `credential:${randomUUID()}`;
      if (failure !== 'missing-session') {
        const owner = failure === 'foreign-session-owner' ? (await fixture()).userId : user.userId;
        await environment.database.insert(environment.schema.session).values({
          id: sessionId,
          userId: owner,
          token: randomUUID(),
          createdAt: new Date(0),
          updatedAt: new Date(),
          expiresAt: failure === 'expired-session' ? new Date(0) : new Date(Date.now() + 60_000),
        });
      }
      await environment.database.insert(environment.schema.prototypeLegacyLineage).values({
        id: legacyLineageId,
        userId: user.userId,
        sessionId,
        originalAuthenticatedAt: null,
        originalExpiresAt: new Date(Date.now() + 60_000),
        revokedAt: failure === 'revoked-lineage' ? new Date() : null,
      });
    }
    await expect(second.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
    expect((await storedFor(user.userId)).refreshes).toHaveLength(0);
    expect(await firstRedis.exists(`${namespace}${code}`)).toBe(0);
  });

  it('ordinary native signout rejects a previously pending raw code while another user can pair', async () => {
    const user = await fixture();
    const other = await fixture();
    const phone = await native.credentials(user.email, password);
    const code = await pending(user.userId);
    const otherCode = await pending(other.userId);
    await native.revoke(phone.refreshToken);
    await expect(first.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
    await assertLegacyNativeTokenPair(await second.consumePairingCode(otherCode), nativeKey, other.userId);
  });

  it.each(['logout-first', 'pair-first'] as const)(
    'native logout racing legacy redemption leaves no active descendants (request start order: %s)',
    async (order) => {
      const user = await fixture();
      const phone = await native.credentials(user.email, password);
      const code = await pending(user.userId);
      const logout = () => native.revoke(phone.refreshToken);
      const pair = () => second.consumePairingCode(code);
      const outcomes =
        order === 'logout-first'
          ? await Promise.allSettled([logout(), pair()])
          : await Promise.allSettled([pair(), logout()]);
      const [logoutOutcome, pairOutcome] = order === 'logout-first' ? outcomes : [outcomes[1], outcomes[0]];
      expect(logoutOutcome.status).toBe('fulfilled');
      if (pairOutcome.status === 'fulfilled' && pairOutcome.value && 'jwt' in pairOutcome.value) {
        expect(await native.validateAccessToken(pairOutcome.value.jwt)).toBeNull();
        await expect(native.refresh(pairOutcome.value.refreshToken)).rejects.toMatchObject({ status: 401 });
      }
      expect((await storedFor(user.userId)).refreshes).toHaveLength(0);
    },
  );

  it('actual canonical signout of a fresh non-legacy session also blocks unknown-source pending codes', async () => {
    const user = await fixture();
    const code = await pending(user.userId);
    const phone = await native.credentials(user.email, password);
    const otherPhone = await native.credentials(user.email, password);
    const sessionId = decodeJwt(phone.jwt).sid;
    const source = (await storedFor(user.userId)).sessions.find((session) => session.id === sessionId);
    expect(source).toBeDefined();
    const context = await environment.auth.$context;
    const cookie = `${context.authCookies.sessionToken.name}=${source!.token}.${await makeSignature(source!.token, context.secret)}`;
    const handler = createPrototypeLegacyHandler(environment.database);
    expect((await storedFor(user.userId)).lineages).toHaveLength(0);
    const signOut = await handler(
      new Request(`${PROTOTYPE_ISSUER}/sign-out`, {
        method: 'POST',
        headers: { cookie, origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(signOut.status).toBe(200);
    expect(await native.validateAccessToken(phone.jwt)).toBeNull();
    await expect(native.refresh(phone.refreshToken)).rejects.toMatchObject({ status: 401 });
    await expect(second.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
    expect(await native.validateAccessToken(otherPhone.jwt)).toMatchObject({ userId: user.userId });
    await assertLegacyNativeTokenPair(await native.refresh(otherPhone.refreshToken), nativeKey, user.userId);
    expect((await storedFor(user.userId)).sessions).toHaveLength(1);
  });

  it.each(['reset-first', 'pair-first'] as const)(
    'actual reset racing legacy redemption leaves no active descendants (request start order: %s)',
    async (order) => {
      const user = await fixture();
      const code = await pending(user.userId);
      const reset = () => resetPassword(user.userId);
      const pair = () => second.consumePairingCode(code);
      const outcomes =
        order === 'reset-first'
          ? await Promise.allSettled([reset(), pair()])
          : await Promise.allSettled([pair(), reset()]);
      const [resetOutcome, pairOutcome] = order === 'reset-first' ? outcomes : [outcomes[1], outcomes[0]];
      expect(resetOutcome.status).toBe('fulfilled');
      if (resetOutcome.status === 'fulfilled' && resetOutcome.value instanceof Response)
        expect(resetOutcome.value.status).toBe(200);
      if (pairOutcome.status === 'fulfilled' && 'jwt' in pairOutcome.value) {
        expect(await native.validateAccessToken(pairOutcome.value.jwt)).toBeNull();
        await expect(native.refresh(pairOutcome.value.refreshToken)).rejects.toMatchObject({ status: 401 });
      }
      expect((await storedFor(user.userId)).refreshes).toHaveLength(0);
      await expect(first.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
    },
  );

  it('reset between GETDEL and canonical issuance prevents a pending code from restoring access', async () => {
    const user = await fixture();
    const code = await pending(user.userId);
    const delayed = createPrototypeLegacyWatchFacade(
      environment.database,
      nativeKey,
      firstRedis,
      namespace,
      cutoverAt,
      {
        afterConsume: async () => {
          expect((await resetPassword(user.userId)).status).toBe(200);
        },
      },
    );
    await expect(delayed.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
    expect(await firstRedis.exists(`${namespace}${code}`)).toBe(0);
    expect((await storedFor(user.userId)).refreshes).toHaveLength(0);
  });

  it('fails closed without Redis and leaves a code for a healthy instance', async () => {
    const user = await fixture();
    const code = await pending(user.userId);
    const disconnected = redisClient();
    try {
      const unavailable = createPrototypeLegacyWatchFacade(
        environment.database,
        nativeKey,
        disconnected,
        namespace,
        cutoverAt,
      );
      await expect(unavailable.consumePairingCode(code)).rejects.toMatchObject({ status: 503 });
    } finally {
      disconnected.disconnect();
    }
    expect((await second.consumePairingCode(code)).userId).toBe(user.userId);
  });

  it('a lost Redis reply after real GETDEL consumes the code without a SQL pair or fallback', async () => {
    const user = await fixture();
    const code = await pending(user.userId);
    const lostReply = createPrototypeLegacyWatchFacade(
      environment.database,
      nativeKey,
      {
        status: 'ready',
        eval: async (script, keyCount, key) => {
          await firstRedis.eval(script, keyCount, key);
          throw new Error('synthetic lost Redis response');
        },
      },
      namespace,
      cutoverAt,
    );
    await expect(lostReply.consumePairingCode(code)).rejects.toMatchObject({ status: 503 });
    expect(await firstRedis.exists(`${namespace}${code}`)).toBe(0);
    expect(await storedFor(user.userId)).toEqual({ sessions: [], refreshes: [], lineages: [] });
    await expect(second.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
  });

  it('failure after GETDEL cannot restore a code or remove the committed cutover epoch', async () => {
    const user = await fixture();
    const code = await pending(user.userId);
    const failing = createPrototypeLegacyWatchFacade(
      environment.database,
      nativeKey,
      firstRedis,
      namespace,
      cutoverAt,
      {
        afterConsume: async () => {
          throw new Error('synthetic failure after GETDEL');
        },
      },
    );
    await expect(failing.consumePairingCode(code)).rejects.toThrow('synthetic failure after GETDEL');
    expect(await firstRedis.exists(`${namespace}${code}`)).toBe(0);
    expect(await storedFor(user.userId)).toEqual({ sessions: [], refreshes: [], lineages: [] });
    const [epoch] = await environment.database
      .select()
      .from(environment.schema.prototypeAuthMigrationEpoch)
      .where(eq(environment.schema.prototypeAuthMigrationEpoch.name, 'legacy-watch'));
    expect(epoch.cutoverAt).toEqual(cutoverAt);
    await expect(second.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
  });

  it('failure after real mint rolls back SQL session, lineage and refresh without restoring Redis consumption', async () => {
    const user = await fixture();
    const code = await pending(user.userId);
    let reachedRealMint = false;
    const failing = createPrototypeLegacyWatchFacade(
      environment.database,
      nativeKey,
      firstRedis,
      namespace,
      cutoverAt,
      {
        afterMutation: async () => {
          reachedRealMint = true;
          throw new Error('synthetic post-mint failure');
        },
      },
    );
    await expect(failing.consumePairingCode(code)).rejects.toThrow('synthetic post-mint failure');
    expect(reachedRealMint).toBe(true);
    expect(await storedFor(user.userId)).toEqual({ sessions: [], refreshes: [], lineages: [] });
    expect(await firstRedis.exists(`${namespace}${code}`)).toBe(0);
    await expect(second.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
  });

  it('a committed consumed-code lineage rejects the same key if an old Redis snapshot is restored', async () => {
    const user = await fixture();
    const code = await pending(user.userId);
    await first.consumePairingCode(code);
    await firstRedis.set(`${namespace}${code}`, user.userId, 'EX', 300);
    await expect(second.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
    expect((await storedFor(user.userId)).refreshes).toHaveLength(1);
  });

  it('captures a mutable caller Date once and rejects another caller moving the persisted horizon', async () => {
    const user = await fixture();
    const code = await pending(user.userId);
    const callerDate = new Date(cutoverAt);
    const captured = createPrototypeLegacyWatchFacade(
      environment.database,
      nativeKey,
      firstRedis,
      namespace,
      callerDate,
    );
    callerDate.setTime(Date.now() + 60_000);
    expect((await captured.consumePairingCode(code)).userId).toBe(user.userId);
    const otherCode = await pending((await fixture()).userId);
    const moved = createPrototypeLegacyWatchFacade(
      environment.database,
      nativeKey,
      secondRedis,
      namespace,
      new Date(cutoverAt.getTime() + 1),
    );
    await expect(moved.consumePairingCode(otherCode)).rejects.toMatchObject({ status: 401 });
    expect(await firstRedis.exists(`${namespace}${otherCode}`)).toBe(1);
  });

  it('the very first failed native mint still commits its immutable epoch outside the rolled-back issuance transaction', async () => {
    const isolated = await createPrototypeEnvironment();
    try {
      const userId = randomUUID();
      await isolated.database
        .insert(isolated.schema.user)
        .values({ id: userId, name: 'First epoch fixture', email: `${userId}@example.test` });
      const firstCode = await pending(userId);
      const isolatedCutover = new Date(Date.now() - 1000);
      const failing = createPrototypeLegacyWatchFacade(
        isolated.database,
        nativeKey,
        firstRedis,
        namespace,
        isolatedCutover,
        {
          afterMutation: async () => {
            throw new Error('synthetic first-mint rollback');
          },
        },
      );
      await expect(failing.consumePairingCode(firstCode)).rejects.toThrow('synthetic first-mint rollback');
      const [epoch] = await isolated.database
        .select()
        .from(isolated.schema.prototypeAuthMigrationEpoch)
        .where(eq(isolated.schema.prototypeAuthMigrationEpoch.name, 'legacy-watch'));
      expect(epoch.cutoverAt).toEqual(isolatedCutover);
      const nextCode = await pending(userId);
      const moved = createPrototypeLegacyWatchFacade(
        isolated.database,
        nativeKey,
        secondRedis,
        namespace,
        new Date(isolatedCutover.getTime() + 1),
      );
      await expect(moved.consumePairingCode(nextCode)).rejects.toMatchObject({ status: 401 });
      expect(await firstRedis.exists(`${namespace}${nextCode}`)).toBe(1);
    } finally {
      await isolated.close();
    }
  });

  it('ordinary verification-token cleanup cannot remove the cutover or authorize a later caller horizon', async () => {
    const markerId = randomUUID();
    await environment.database.insert(environment.schema.verification).values({
      id: markerId,
      identifier: markerId,
      value: 'synthetic-expired-marker',
      expiresAt: new Date(0),
    });
    await environment.database
      .delete(environment.schema.verification)
      .where(eq(environment.schema.verification.id, markerId));
    const user = await fixture();
    const code = await pending(user.userId);
    const moved = createPrototypeLegacyWatchFacade(
      environment.database,
      nativeKey,
      secondRedis,
      namespace,
      new Date(cutoverAt.getTime() + 1),
    );
    await expect(moved.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
    expect(await firstRedis.exists(`${namespace}${code}`)).toBe(1);
    const [epoch] = await environment.database
      .select()
      .from(environment.schema.prototypeAuthMigrationEpoch)
      .where(eq(environment.schema.prototypeAuthMigrationEpoch.name, 'legacy-watch'));
    expect(epoch.cutoverAt).toEqual(cutoverAt);
  });

  it('the legacy window closes at 300 seconds even while a Redis key still has positive TTL', async () => {
    const user = await fixture();
    const code = await pending(user.userId);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(cutoverAt.getTime() + 300_000);
      await expect(second.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
      expect(await firstRedis.pttl(`${namespace}${code}`)).toBeGreaterThan(0);
      const moved = createPrototypeLegacyWatchFacade(
        environment.database,
        nativeKey,
        secondRedis,
        namespace,
        new Date(),
      );
      await expect(moved.consumePairingCode(code)).rejects.toMatchObject({ status: 401 });
    } finally {
      vi.useRealTimers();
    }
    expect((await storedFor(user.userId)).refreshes).toHaveLength(0);
  });

  it('rejects future/invalid cutovers and production Redis prefixes', () => {
    expect(() =>
      createPrototypeLegacyWatchFacade(
        environment.database,
        nativeKey,
        firstRedis,
        namespace,
        new Date(Date.now() + 60_000),
      ),
    ).toThrow();
    expect(() =>
      createPrototypeLegacyWatchFacade(environment.database, nativeKey, firstRedis, namespace, new Date(Number.NaN)),
    ).toThrow();
    expect(() =>
      createPrototypeLegacyWatchFacade(environment.database, nativeKey, firstRedis, 'watch:pair:', cutoverAt),
    ).toThrow();
  });
});
