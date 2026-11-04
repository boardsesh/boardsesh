import { createHash, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { createPrototypeNativeFacade, PrototypeNativeCredentialError } from '../identity-native-facade';
import {
  createPrototypeWatchFacade,
  PROTOTYPE_WATCH_CODE_ALPHABET,
  PrototypeWatchPairingError,
} from '../identity-watch-facade';
import { createPrototypeLegacyHandler } from '../legacy-bridge';
import { PROTOTYPE_ISSUER } from '../oauth-options';
import { assertLegacyNativeTokenPair } from './identity-native-contract';

const nativeKey = new TextEncoder().encode('boardsesh-synthetic-watch-contract-key-6975');
const password = 'synthetic-watch-password';
const namespace = `boardsesh:ba01:watch:${randomUUID()}:`;

function redisUrl() {
  const url = new URL(process.env.AUTH_PROTOTYPE_REDIS_URL ?? 'redis://127.0.0.1:6380');
  if (url.protocol !== 'redis:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.search) {
    throw new Error('The watch proof requires a local Redis URL without URL options');
  }
  return url.toString();
}

function redisClient() {
  const client = new Redis(redisUrl(), {
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

describe('Garmin pairing over real Redis and the canonical native authority', () => {
  let environment: Awaited<ReturnType<typeof createPrototypeEnvironment>>;
  let firstRedis: Redis;
  let secondRedis: Redis;
  let firstNative: ReturnType<typeof createPrototypeNativeFacade>;
  let secondNative: ReturnType<typeof createPrototypeNativeFacade>;
  let firstWatch: ReturnType<typeof createPrototypeWatchFacade>;
  let secondWatch: ReturnType<typeof createPrototypeWatchFacade>;
  let passwordHash: string;

  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    firstRedis = redisClient();
    secondRedis = redisClient();
    await Promise.all([firstRedis.connect(), secondRedis.connect()]);
    passwordHash = await hash(password, 4);
    firstNative = createPrototypeNativeFacade(environment.database, nativeKey);
    secondNative = createPrototypeNativeFacade(environment.database, nativeKey);
    firstWatch = createPrototypeWatchFacade(firstNative, firstRedis, namespace);
    secondWatch = createPrototypeWatchFacade(secondNative, secondRedis, namespace);
  });

  afterAll(async () => {
    try {
      if (firstRedis?.status === 'ready') {
        // This randomly named fixture namespace is the only state we remove.
        const keys = await firstRedis.keys(`${namespace}*`);
        if (keys.length > 0) await firstRedis.del(...keys);
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
    await environment.database.insert(environment.schema.user).values({ id: userId, email, name: 'Watch fixture' });
    await environment.database.insert(environment.schema.account).values({
      id: randomUUID(),
      userId,
      accountId: userId,
      providerId: 'credential',
      password: passwordHash,
    });
    const phone = await firstNative.credentials(email, password);
    const sessionId = decodeJwt(phone.jwt).sid as string;
    return { userId, email, phone, sessionId };
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
        body: JSON.stringify({ token: resetToken, newPassword: 'changed-watch-fixture-password' }),
      }),
    );
  }

  it('preserves the issued code shape, exact Redis lifetime and released native token-pair contract', async () => {
    const user = await fixture();
    const before = Date.now();
    const issued = await firstWatch.createPairingCode(user.phone.jwt);
    expect(issued.code).toHaveLength(8);
    expect(issued.code.split('').every((character) => PROTOTYPE_WATCH_CODE_ALPHABET.includes(character))).toBe(true);
    expect(Date.parse(issued.expiresAt) - before).toBeGreaterThanOrEqual(300_000);
    expect(Date.parse(issued.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    expect(await firstRedis.ttl(`${namespace}${issued.code}`)).toBeGreaterThanOrEqual(299);
    expect(await firstRedis.ttl(`${namespace}${issued.code}`)).toBeLessThanOrEqual(300);
    const watch = await secondWatch.consumePairingCode(issued.code);
    const claims = await assertLegacyNativeTokenPair(watch, nativeKey, user.userId);
    expect(claims.sid).toBe(user.sessionId);
    expect(await firstNative.validateAccessToken(watch.jwt)).toEqual({
      userId: user.userId,
      sessionId: user.sessionId,
    });
    const [refresh] = await environment.database
      .select()
      .from(environment.schema.prototypeNativeRefresh)
      .where(
        eq(
          environment.schema.prototypeNativeRefresh.tokenHash,
          createHash('sha256').update(watch.refreshToken).digest('hex'),
        ),
      );
    expect(refresh.sessionId).toBe(user.sessionId);
    expect(refresh.expiresAt.getTime() - refresh.createdAt.getTime()).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it('normalizes lower-case hand entry and separators like the released watch endpoint', async () => {
    const user = await fixture();
    const issued = await firstWatch.createPairingCode(user.phone.jwt);
    const handEntered = ` ${issued.code.slice(0, 4).toLowerCase()} - ${issued.code.slice(4).toLowerCase()} `;
    expect((await secondWatch.consumePairingCode(handEntered)).userId).toBe(user.userId);
  });

  it('allows exactly one concurrent GETDEL redemption across two independent clients', async () => {
    const user = await fixture();
    const issued = await firstWatch.createPairingCode(user.phone.jwt);
    const outcomes = await Promise.allSettled([
      firstWatch.consumePairingCode(issued.code),
      secondWatch.consumePairingCode(issued.code),
    ]);
    const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(accepted).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    if (accepted[0].status !== 'fulfilled') throw new Error('Expected one accepted watch pairing');
    await assertLegacyNativeTokenPair(accepted[0].value, nativeKey, user.userId);
    await expect(secondWatch.consumePairingCode(issued.code)).rejects.toMatchObject({ status: 401 });
  });

  it('retains a pending code and an already paired watch after handler recreation', async () => {
    const user = await fixture();
    const issued = await firstWatch.createPairingCode(user.phone.jwt);
    const recreated = createPrototypeWatchFacade(secondNative, secondRedis, namespace);
    const watch = await recreated.consumePairingCode(issued.code);
    const recreatedNative = createPrototypeNativeFacade(environment.database, nativeKey);
    const refreshed = await recreatedNative.refresh(watch.refreshToken);
    await assertLegacyNativeTokenPair(refreshed, nativeKey, user.userId);
    expect(await recreatedNative.validateAccessToken(refreshed.jwt)).toEqual({
      userId: user.userId,
      sessionId: user.sessionId,
    });
  });

  it('rejects an actually expired Redis code without minting watch credentials', async () => {
    const user = await fixture();
    const issued = await firstWatch.createPairingCode(user.phone.jwt);
    await firstRedis.pexpire(`${namespace}${issued.code}`, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(secondWatch.consumePairingCode(issued.code)).rejects.toMatchObject({ status: 401 });
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeNativeRefresh)
        .where(eq(environment.schema.prototypeNativeRefresh.userId, user.userId)),
    ).toHaveLength(1);
  });

  it.each(['', 'short', null, 42, {}, '123456789'])('rejects malformed pairing input %j', async (candidate) => {
    await expect(firstWatch.consumePairingCode(candidate)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects unknown codes and invalid first-party credentials', async () => {
    // I is excluded from allocation, so this cannot collide with a live code.
    await expect(firstWatch.consumePairingCode('IIIIIIII')).rejects.toMatchObject({ status: 401 });
    await expect(firstWatch.createPairingCode('not-a-signed-first-party-token')).rejects.toMatchObject({ status: 401 });
  });

  it('does not overwrite a live code when allocation exhausts all five collisions', async () => {
    const firstUser = await fixture();
    const otherUser = await fixture();
    let allocations = 0;
    const colliding = createPrototypeWatchFacade(firstNative, firstRedis, namespace, () => {
      allocations += 1;
      return 'ABCDEFG3';
    });
    const original = await colliding.createPairingCode(firstUser.phone.jwt);
    await expect(colliding.createPairingCode(otherUser.phone.jwt)).rejects.toMatchObject({ status: 503 });
    expect(allocations).toBe(6);
    expect((await secondWatch.consumePairingCode(original.code)).userId).toBe(firstUser.userId);
  });

  it('fails closed without Redis and leaves the existing code available to a healthy instance', async () => {
    const user = await fixture();
    const issued = await firstWatch.createPairingCode(user.phone.jwt);
    const disconnected = redisClient();
    try {
      const unavailable = createPrototypeWatchFacade(firstNative, disconnected, namespace);
      await expect(unavailable.createPairingCode(user.phone.jwt)).rejects.toMatchObject({ status: 503 });
      await expect(unavailable.consumePairingCode(issued.code)).rejects.toMatchObject({ status: 503 });
    } finally {
      disconnected.disconnect();
    }
    expect((await secondWatch.consumePairingCode(issued.code)).userId).toBe(user.userId);
  });

  it('a consumed code cannot be replayed after a successful issuance response is lost', async () => {
    const user = await fixture();
    const issued = await firstWatch.createPairingCode(user.phone.jwt);
    let mintedPair: Awaited<ReturnType<typeof firstNative.issueForVerifiedSession>> | undefined;
    const failing = createPrototypeWatchFacade(
      {
        ...firstNative,
        async issueForVerifiedSession(userId, sessionId) {
          mintedPair = await firstNative.issueForVerifiedSession(userId, sessionId);
          throw new Error('Synthetic issuance interruption');
        },
      },
      firstRedis,
      namespace,
    );
    await expect(failing.consumePairingCode(issued.code)).rejects.toThrow('Synthetic issuance interruption');
    expect(mintedPair).toBeDefined();
    await assertLegacyNativeTokenPair(mintedPair, nativeKey, user.userId);
    await expect(secondWatch.consumePairingCode(issued.code)).rejects.toMatchObject({ status: 401 });
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeNativeRefresh)
        .where(eq(environment.schema.prototypeNativeRefresh.userId, user.userId)),
    ).toHaveLength(2);
  });

  it('rejects a wrong-owner/session binding even when supplied by the internal pairing store', async () => {
    const user = await fixture();
    const otherUser = await fixture();
    await firstRedis.set(
      `${namespace}ABCDEFG4`,
      JSON.stringify({ version: 1, userId: otherUser.userId, sessionId: user.sessionId }),
      'EX',
      300,
    );
    await expect(secondWatch.consumePairingCode('ABCDEFG4')).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    await expect(firstWatch.consumePairingCode('ABCDEFG4')).rejects.toMatchObject({ status: 401 });
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeNativeRefresh)
        .where(eq(environment.schema.prototypeNativeRefresh.userId, otherUser.userId)),
    ).toHaveLength(1);
  });

  it('rejects old user-only production code values and malformed bindings instead of inventing a session', async () => {
    const user = await fixture();
    for (const binding of [
      user.userId,
      JSON.stringify({ userId: user.userId }),
      JSON.stringify({ version: 1, userId: user.userId, sessionId: user.sessionId, untrusted: true }),
    ]) {
      await firstRedis.set(`${namespace}ABCDEFG5`, binding, 'EX', 300);
      await expect(secondWatch.consumePairingCode('ABCDEFG5')).rejects.toMatchObject({ status: 401 });
    }
  });

  it('code redemption does not make an old canonical authentication fresh', async () => {
    const user = await fixture();
    const originalAuthenticatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await environment.database
      .update(environment.schema.session)
      .set({ createdAt: originalAuthenticatedAt })
      .where(eq(environment.schema.session.id, user.sessionId));
    const issued = await firstWatch.createPairingCode(user.phone.jwt);
    const watch = await secondWatch.consumePairingCode(issued.code);
    const claims = await assertLegacyNativeTokenPair(watch, nativeKey, user.userId);
    expect(claims.auth_time).toBe(Math.floor(originalAuthenticatedAt.getTime() / 1000));
    expect(claims.iat).toBeGreaterThan(claims.auth_time as number);
  });

  it('code redemption retains unknown age for an imported legacy lineage', async () => {
    const user = await fixture();
    await environment.database
      .update(environment.schema.session)
      .set({
        createdAt: new Date(0),
        originalAuthenticatedAt: null,
        legacyLineageId: `credential:${randomUUID()}`,
      })
      .where(eq(environment.schema.session.id, user.sessionId));
    const issued = await firstWatch.createPairingCode(user.phone.jwt);
    const watch = await secondWatch.consumePairingCode(issued.code);
    expect((await assertLegacyNativeTokenPair(watch, nativeKey, user.userId)).auth_time).toBeUndefined();
  });

  it('a code issued before whole-account sign-out cannot create another watch session', async () => {
    const user = await fixture();
    const issued = await firstWatch.createPairingCode(user.phone.jwt);
    await secondNative.revoke(user.phone.refreshToken);
    await expect(firstWatch.consumePairingCode(issued.code)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    expect(await firstNative.validateAccessToken(user.phone.jwt)).toBeNull();
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeNativeRefresh)
        .where(eq(environment.schema.prototypeNativeRefresh.userId, user.userId)),
    ).toHaveLength(0);
  });

  it.each(['expired-session', 'deleted-user', 'revocation-cutoff'] as const)(
    'a still-live code cannot bypass a canonical %s',
    async (failure) => {
      const user = await fixture();
      const issued = await firstWatch.createPairingCode(user.phone.jwt);
      if (failure === 'expired-session') {
        await environment.database
          .update(environment.schema.session)
          .set({ expiresAt: new Date(0) })
          .where(eq(environment.schema.session.id, user.sessionId));
      } else if (failure === 'deleted-user') {
        await environment.database.delete(environment.schema.user).where(eq(environment.schema.user.id, user.userId));
      } else {
        await environment.database.insert(environment.schema.prototypeUserCutoff).values({
          userId: user.userId,
          revokedThrough: new Date(Date.now() + 1000),
        });
      }
      expect(await firstRedis.ttl(`${namespace}${issued.code}`)).toBeGreaterThan(0);
      await expect(secondWatch.consumePairingCode(issued.code)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
      await expect(firstWatch.consumePairingCode(issued.code)).rejects.toMatchObject({ status: 401 });
    },
  );

  it.each(['reset-first', 'pair-first'] as const)(
    'reset racing watch redemption leaves no active descendants (request start order: %s)',
    async (order) => {
      const user = await fixture();
      const issued = await firstWatch.createPairingCode(user.phone.jwt);
      const reset = () => resetPassword(user.userId);
      const pair = () => secondWatch.consumePairingCode(issued.code);
      const outcomes =
        order === 'reset-first'
          ? await Promise.allSettled([reset(), pair()])
          : await Promise.allSettled([pair(), reset()]);
      const [resetOutcome, pairOutcome] = order === 'reset-first' ? outcomes : [outcomes[1], outcomes[0]];
      expect(resetOutcome.status).toBe('fulfilled');
      if (resetOutcome.status === 'fulfilled' && resetOutcome.value instanceof Response) {
        expect(resetOutcome.value.status).toBe(200);
      }
      if (pairOutcome.status === 'fulfilled' && pairOutcome.value && 'jwt' in pairOutcome.value) {
        expect(await firstNative.validateAccessToken(pairOutcome.value.jwt)).toBeNull();
      }
      expect(
        await environment.database
          .select()
          .from(environment.schema.prototypeNativeRefresh)
          .where(eq(environment.schema.prototypeNativeRefresh.userId, user.userId)),
      ).toHaveLength(0);
      await expect(firstWatch.consumePairingCode(issued.code)).rejects.toBeInstanceOf(PrototypeWatchPairingError);
    },
  );

  it('a pair minted before reset cannot regain access when its response arrives afterward', async () => {
    const user = await fixture();
    const issued = await firstWatch.createPairingCode(user.phone.jwt);
    const delayed = createPrototypeWatchFacade(
      {
        ...firstNative,
        async issueForVerifiedSession(userId, sessionId) {
          const minted = await firstNative.issueForVerifiedSession(userId, sessionId);
          expect((await resetPassword(userId)).status).toBe(200);
          return minted;
        },
      },
      firstRedis,
      namespace,
    );
    const latePair = await delayed.consumePairingCode(issued.code);
    await assertLegacyNativeTokenPair(latePair, nativeKey, user.userId);
    expect(await secondNative.validateAccessToken(latePair.jwt)).toBeNull();
    await expect(secondNative.refresh(latePair.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    await expect(secondWatch.consumePairingCode(issued.code)).rejects.toMatchObject({ status: 401 });
  });
});
