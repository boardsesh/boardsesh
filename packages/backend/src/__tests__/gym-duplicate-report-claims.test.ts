import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { logger } from '../utils/logger';
import {
  acquireGymDuplicateReportClaim,
  GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS,
  gymDuplicateReportClaimKey,
  reconcileGymDuplicateReportClaims,
  releaseGymDuplicateReportClaim,
  resetGymDuplicateReportClaimsForTests,
  type GymDuplicateReportClaimDependencies,
  type GymDuplicateReportRedisClient,
} from '../utils/gym-duplicate-report-claims';

class FakeRedisClaimClient implements GymDuplicateReportRedisClient {
  readonly claims = new Map<string, { ownerToken: string; expiresAt: number }>();
  readonly setCalls: Array<{ key: string; ownerToken: string; expiryMode: 'PXAT'; expiry: number }> = [];
  throwAfterNextSet = false;
  throwBeforeNextSet = false;

  constructor(private readonly now: () => number = Date.now) {}

  private pruneExpired(key: string): void {
    const claim = this.claims.get(key);
    if (claim && claim.expiresAt <= this.now()) this.claims.delete(key);
  }

  async set(
    key: string,
    ownerToken: string,
    expiryMode: 'PXAT',
    expiry: number,
    _condition: 'NX',
  ): Promise<'OK' | null> {
    this.setCalls.push({ key, ownerToken, expiryMode, expiry });
    if (this.throwBeforeNextSet) {
      this.throwBeforeNextSet = false;
      throw new Error('connection closed before write');
    }
    this.pruneExpired(key);
    if (this.claims.has(key)) return null;
    this.claims.set(key, { ownerToken, expiresAt: expiry });
    if (this.throwAfterNextSet) {
      this.throwAfterNextSet = false;
      throw new Error('connection closed after write');
    }
    return 'OK';
  }

  async eval(_script: string, _numberOfKeys: number, key: string, ownerToken: string): Promise<number> {
    this.pruneExpired(key);
    if (this.claims.get(key)?.ownerToken !== ownerToken) return 0;
    this.claims.delete(key);
    return 1;
  }
}

function createDependencies(options: {
  redisClient?: GymDuplicateReportRedisClient;
  connected?: boolean;
  now?: () => number;
  tokens: string[];
}): GymDuplicateReportClaimDependencies {
  let tokenIndex = 0;
  return {
    isRedisConnected: () => options.connected ?? false,
    getRedisClient: () => {
      if (!options.redisClient) throw new Error('Redis client was not supplied');
      return options.redisClient;
    },
    createOwnerToken: () => options.tokens[tokenIndex++] ?? `owner-${tokenIndex}`,
    now: options.now ?? Date.now,
  };
}

beforeEach(() => {
  resetGymDuplicateReportClaimsForTests();
});

describe('gym duplicate report claim ownership', () => {
  it('builds one stable key for either ordering of a UUID pair', () => {
    const firstUuid = '00000000-0000-4000-8000-000000000002';
    const secondUuid = '00000000-0000-4000-8000-000000000001';
    const expectedKey = `gymDuplicateReport:${secondUuid}:${firstUuid}`;

    expect(gymDuplicateReportClaimKey(firstUuid, secondUuid)).toBe(expectedKey);
    expect(gymDuplicateReportClaimKey(secondUuid, firstUuid)).toBe(expectedKey);
  });

  it('does not let an expired local owner release its successor', async () => {
    let now = 1_000;
    const key = 'gymDuplicateReport:test:local-owner';
    const dependencies = createDependencies({
      connected: false,
      now: () => now,
      tokens: ['expired-owner', 'successor-owner', 'third-owner'],
    });
    const expiredResult = await acquireGymDuplicateReportClaim(key, dependencies);
    expect(expiredResult.status).toBe('acquired');
    if (expiredResult.status !== 'acquired') throw new Error('Expected the first local claim');

    now += GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS * 1000 + 1;
    const successorResult = await acquireGymDuplicateReportClaim(key, dependencies);
    expect(successorResult.status).toBe('acquired');
    if (successorResult.status !== 'acquired') throw new Error('Expected the successor local claim');

    await releaseGymDuplicateReportClaim(expiredResult.claim);
    await expect(acquireGymDuplicateReportClaim(key, dependencies)).resolves.toEqual({ status: 'already_claimed' });

    await releaseGymDuplicateReportClaim(successorResult.claim);
    await expect(acquireGymDuplicateReportClaim(key, dependencies)).resolves.toMatchObject({ status: 'acquired' });
  });

  it('releases the fresh local owner when SET NX returns null after process-local state resets', async () => {
    const redisClient = new FakeRedisClaimClient();
    const key = 'gymDuplicateReport:test:redis-survives-reset';
    const firstDependencies = createDependencies({ connected: true, redisClient, tokens: ['first-owner'] });
    const secondDependencies = createDependencies({ connected: true, redisClient, tokens: ['second-owner'] });

    await expect(acquireGymDuplicateReportClaim(key, firstDependencies)).resolves.toMatchObject({
      status: 'acquired',
    });
    resetGymDuplicateReportClaimsForTests();

    await expect(acquireGymDuplicateReportClaim(key, secondDependencies)).resolves.toEqual({
      status: 'already_claimed',
    });
    expect(redisClient.claims.get(key)?.ownerToken).toBe('first-owner');

    // The null SET result must also release the just-created local owner. Once
    // the prior Redis owner disappears, a new request can acquire immediately.
    redisClient.claims.delete(key);
    const successorDependencies = createDependencies({ connected: true, redisClient, tokens: ['successor-owner'] });
    await expect(acquireGymDuplicateReportClaim(key, successorDependencies)).resolves.toMatchObject({
      status: 'acquired',
      claim: { ownerToken: 'successor-owner' },
    });
  });

  it('pins a directly-acquired Redis claim to the local absolute expiry', async () => {
    const now = 5_000;
    const redisClient = new FakeRedisClaimClient(() => now);
    const key = 'gymDuplicateReport:test:direct-absolute-expiry';

    await expect(
      acquireGymDuplicateReportClaim(
        key,
        createDependencies({ connected: true, redisClient, now: () => now, tokens: ['direct-owner'] }),
      ),
    ).resolves.toMatchObject({ status: 'acquired' });

    expect(redisClient.setCalls).toEqual([
      {
        key,
        ownerToken: 'direct-owner',
        expiryMode: 'PXAT',
        expiry: now + GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS * 1000,
      },
    ]);
  });

  it('does not re-SET an already-distributed claim during forced readiness reconciliation', async () => {
    const redisClient = new FakeRedisClaimClient();
    const key = 'gymDuplicateReport:test:already-distributed';
    await acquireGymDuplicateReportClaim(
      key,
      createDependencies({ connected: true, redisClient, tokens: ['distributed-owner'] }),
    );
    expect(redisClient.setCalls).toHaveLength(1);

    await reconcileGymDuplicateReportClaims(redisClient, Date.now, true);

    expect(redisClient.setCalls).toHaveLength(1);
    expect(redisClient.claims.get(key)?.ownerToken).toBe('distributed-owner');
  });

  it('retains the local claim when Redis reports connected but its client is unavailable', async () => {
    const key = 'gymDuplicateReport:test:client-unavailable';
    const dependencies = createDependencies({ connected: true, tokens: ['local-owner', 'retry-owner'] });

    const firstResult = await acquireGymDuplicateReportClaim(key, dependencies);
    expect(firstResult.status).toBe('acquired');
    if (firstResult.status !== 'acquired') throw new Error('Expected a local-only claim');
    expect(firstResult.claim).toEqual({ key, ownerToken: 'local-owner' });
    expect(Object.isFrozen(firstResult.claim)).toBe(true);

    await expect(acquireGymDuplicateReportClaim(key, dependencies)).resolves.toEqual({ status: 'already_claimed' });

    await releaseGymDuplicateReportClaim(firstResult.claim);
    await expect(acquireGymDuplicateReportClaim(key, dependencies)).resolves.toMatchObject({ status: 'acquired' });
  });

  it('uses owner checks for both local and Redis release', async () => {
    const redisClient = new FakeRedisClaimClient();
    const key = 'gymDuplicateReport:test:redis-owner';
    const oldDependencies = createDependencies({ connected: true, redisClient, tokens: ['old-owner'] });
    const oldResult = await acquireGymDuplicateReportClaim(key, oldDependencies);
    if (oldResult.status !== 'acquired') throw new Error('Expected the old claim');

    // Model expiry/process hand-off without clearing unrelated Redis state: this
    // exact key alone expires, then a successor acquires it.
    resetGymDuplicateReportClaimsForTests();
    redisClient.claims.delete(key);
    const successorDependencies = createDependencies({ connected: true, redisClient, tokens: ['successor-owner'] });
    const successorResult = await acquireGymDuplicateReportClaim(key, successorDependencies);
    if (successorResult.status !== 'acquired') throw new Error('Expected the successor claim');

    await releaseGymDuplicateReportClaim(oldResult.claim);
    expect(redisClient.claims.get(key)?.ownerToken).toBe('successor-owner');
    await expect(acquireGymDuplicateReportClaim(key, successorDependencies)).resolves.toEqual({
      status: 'already_claimed',
    });

    await releaseGymDuplicateReportClaim(successorResult.claim);
    expect(redisClient.claims.has(key)).toBe(false);
  });

  it('remembers an apply-then-throw token so owner-checked cleanup permits retry', async () => {
    const redisClient = new FakeRedisClaimClient();
    redisClient.throwAfterNextSet = true;
    const key = 'gymDuplicateReport:test:ambiguous-set';
    const firstDependencies = createDependencies({ connected: true, redisClient, tokens: ['ambiguous-owner'] });
    const firstResult = await acquireGymDuplicateReportClaim(key, firstDependencies);
    if (firstResult.status !== 'acquired') throw new Error('Expected the ambiguous claim to degrade locally');
    expect(redisClient.claims.get(key)?.ownerToken).toBe('ambiguous-owner');

    await releaseGymDuplicateReportClaim(firstResult.claim);
    expect(redisClient.claims.has(key)).toBe(false);

    const retryDependencies = createDependencies({ connected: true, redisClient, tokens: ['retry-owner'] });
    await expect(acquireGymDuplicateReportClaim(key, retryDependencies)).resolves.toMatchObject({
      status: 'acquired',
    });
  });

  it('promotes an outage claim with only its remaining TTL and suppresses another instance', async () => {
    let now = 10_000;
    const redisClient = new FakeRedisClaimClient(() => now);
    const key = 'gymDuplicateReport:test:outage-recovery';
    const outageDependencies = createDependencies({
      connected: false,
      now: () => now,
      tokens: ['outage-owner'],
    });

    const outageResult = await acquireGymDuplicateReportClaim(key, outageDependencies);
    expect(outageResult.status).toBe('acquired');
    if (outageResult.status !== 'acquired') throw new Error('Expected a local outage claim');

    now += 90 * 60 * 1000;
    await reconcileGymDuplicateReportClaims(redisClient, () => now);

    const localExpiresAt = 10_000 + GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS * 1000;
    expect(redisClient.setCalls).toContainEqual({
      key,
      ownerToken: 'outage-owner',
      expiryMode: 'PXAT',
      expiry: localExpiresAt,
    });
    expect(redisClient.claims.get(key)).toEqual({
      ownerToken: 'outage-owner',
      expiresAt: localExpiresAt,
    });

    // Model a different instance/restart with no process-local memory. The
    // promoted Redis owner must still suppress the duplicate.
    resetGymDuplicateReportClaimsForTests();
    const otherInstanceDependencies = createDependencies({
      connected: true,
      redisClient,
      now: () => now,
      tokens: ['other-instance-owner'],
    });
    await expect(acquireGymDuplicateReportClaim(key, otherInstanceDependencies)).resolves.toEqual({
      status: 'already_claimed',
    });
    expect(redisClient.claims.get(key)?.ownerToken).toBe('outage-owner');

    await releaseGymDuplicateReportClaim(outageResult.claim);
    expect(redisClient.claims.has(key)).toBe(false);
  });

  it('drops an expired local outage claim instead of promoting or extending it', async () => {
    let now = 20_000;
    const redisClient = new FakeRedisClaimClient(() => now);
    const key = 'gymDuplicateReport:test:expired-before-recovery';
    await acquireGymDuplicateReportClaim(
      key,
      createDependencies({ connected: false, now: () => now, tokens: ['expired-owner'] }),
    );

    now += GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS * 1000 + 1;
    await reconcileGymDuplicateReportClaims(redisClient, () => now);

    expect(redisClient.setCalls).toHaveLength(0);
    expect(redisClient.claims.has(key)).toBe(false);
    await expect(
      acquireGymDuplicateReportClaim(
        key,
        createDependencies({ connected: false, now: () => now, tokens: ['fresh-owner'] }),
      ),
    ).resolves.toMatchObject({ status: 'acquired' });
  });

  it('never overwrites a conflicting distributed owner and retries after it clears', async () => {
    let now = 30_000;
    const redisClient = new FakeRedisClaimClient(() => now);
    const key = 'gymDuplicateReport:test:promotion-conflict';
    await acquireGymDuplicateReportClaim(
      key,
      createDependencies({ connected: false, now: () => now, tokens: ['local-owner'] }),
    );
    redisClient.claims.set(key, {
      ownerToken: 'distributed-owner',
      expiresAt: now + 60_000,
    });

    await reconcileGymDuplicateReportClaims(redisClient, () => now);
    expect(redisClient.claims.get(key)?.ownerToken).toBe('distributed-owner');

    redisClient.claims.delete(key);
    now += 5_000;
    await reconcileGymDuplicateReportClaims(redisClient, () => now);
    expect(redisClient.claims.get(key)?.ownerToken).toBe('local-owner');
    expect(redisClient.setCalls.at(-1)).toMatchObject({
      expiryMode: 'PXAT',
      expiry: 30_000 + GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS * 1000,
    });
  });

  it('keeps a failed promotion local and retries without logging keys or owner tokens', async () => {
    let now = 40_000;
    const redisClient = new FakeRedisClaimClient(() => now);
    redisClient.throwBeforeNextSet = true;
    const key = 'gymDuplicateReport:test:promotion-retry';
    const ownerToken = 'private-owner-token';
    await acquireGymDuplicateReportClaim(
      key,
      createDependencies({ connected: false, now: () => now, tokens: [ownerToken] }),
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    await reconcileGymDuplicateReportClaims(redisClient, () => now);
    expect(redisClient.claims.has(key)).toBe(false);

    now += 2_000;
    await reconcileGymDuplicateReportClaims(redisClient, () => now);
    expect(redisClient.claims.get(key)?.ownerToken).toBe(ownerToken);
    expect(redisClient.setCalls.at(-1)?.expiry).toBe(40_000 + GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS * 1000);
    const warningOutput = JSON.stringify(warnSpy.mock.calls);
    expect(warningOutput).not.toContain(key);
    expect(warningOutput).not.toContain(ownerToken);
    warnSpy.mockRestore();
  });

  it('backs off opportunistic promotion retries while a Redis partition persists', async () => {
    let now = 45_000;
    const outageKey = 'gymDuplicateReport:test:promotion-backoff';
    const setSpy = vi.fn().mockRejectedValue(new Error('partition persists'));
    const redisClient: GymDuplicateReportRedisClient = {
      set: setSpy,
      eval: vi.fn().mockResolvedValue(0),
    };
    await acquireGymDuplicateReportClaim(
      outageKey,
      createDependencies({ connected: false, now: () => now, tokens: ['outage-owner'] }),
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const connectedDependencies = createDependencies({
      connected: true,
      redisClient,
      now: () => now,
      tokens: ['request-one', 'request-two', 'request-three'],
    });

    await acquireGymDuplicateReportClaim('gymDuplicateReport:test:request-one', connectedDependencies);
    expect(setSpy.mock.calls.filter(([key]) => key === outageKey)).toHaveLength(1);

    await acquireGymDuplicateReportClaim('gymDuplicateReport:test:request-two', connectedDependencies);
    expect(setSpy.mock.calls.filter(([key]) => key === outageKey)).toHaveLength(1);

    now += 60_000;
    await acquireGymDuplicateReportClaim('gymDuplicateReport:test:request-three', connectedDependencies);
    expect(setSpy.mock.calls.filter(([key]) => key === outageKey)).toHaveLength(2);
    warnSpy.mockRestore();
  });

  it('drains a new local claim that arrives during an awaited readiness promotion', async () => {
    const firstKey = 'gymDuplicateReport:test:snapshot-first';
    const secondKey = 'gymDuplicateReport:test:snapshot-second';
    let finishFirstPromotion: ((result: 'OK') => void) | undefined;
    const setSpy = vi.fn((key: string) => {
      if (key === firstKey) {
        return new Promise<'OK'>((resolve) => {
          finishFirstPromotion = resolve;
        });
      }
      return Promise.resolve('OK' as const);
    });
    const redisClient: GymDuplicateReportRedisClient = {
      set: setSpy,
      eval: vi.fn().mockResolvedValue(0),
    };
    await acquireGymDuplicateReportClaim(firstKey, createDependencies({ connected: false, tokens: ['first-owner'] }));

    const firstReconciliation = reconcileGymDuplicateReportClaims(redisClient);
    await vi.waitFor(() => expect(setSpy).toHaveBeenCalledTimes(1));
    await acquireGymDuplicateReportClaim(secondKey, createDependencies({ connected: false, tokens: ['second-owner'] }));

    finishFirstPromotion?.('OK');
    await firstReconciliation;
    expect(setSpy.mock.calls.map(([key]) => key)).toEqual([firstKey, secondKey]);
  });

  it('retries with a recovered client after an older in-flight promotion fails', async () => {
    const now = 50_000;
    const key = 'gymDuplicateReport:test:concurrent-recovery';
    let rejectStalePromotion: ((error: Error) => void) | undefined;
    const staleSet = vi.fn(
      () =>
        new Promise<'OK'>((_resolve, reject) => {
          rejectStalePromotion = reject;
        }),
    );
    const staleRedisClient: GymDuplicateReportRedisClient = {
      set: staleSet,
      eval: vi.fn().mockResolvedValue(0),
    };
    const recoveredRedisClient = new FakeRedisClaimClient(() => now);
    await acquireGymDuplicateReportClaim(
      key,
      createDependencies({ connected: false, now: () => now, tokens: ['outage-owner'] }),
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    const staleReconciliation = reconcileGymDuplicateReportClaims(staleRedisClient, () => now);
    await vi.waitFor(() => expect(staleSet).toHaveBeenCalledTimes(1));
    const recoveredReconciliation = reconcileGymDuplicateReportClaims(recoveredRedisClient, () => now);
    await vi.waitFor(() => expect(recoveredRedisClient.setCalls).toHaveLength(0));

    rejectStalePromotion?.(new Error('stale client disconnected'));
    await Promise.all([staleReconciliation, recoveredReconciliation]);

    expect(recoveredRedisClient.setCalls).toContainEqual({
      key,
      ownerToken: 'outage-owner',
      expiryMode: 'PXAT',
      expiry: now + GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS * 1000,
    });
    expect(recoveredRedisClient.claims.get(key)?.ownerToken).toBe('outage-owner');
    warnSpy.mockRestore();
  });

  it('uses the original absolute expiry when Redis delays a promotion command', async () => {
    let now = 60_000;
    const originalExpiresAt = now + GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS * 1000;
    const key = 'gymDuplicateReport:test:delayed-promotion';
    let finishPromotion: ((result: 'OK') => void) | undefined;
    const setSpy = vi.fn(
      () =>
        new Promise<'OK'>((resolve) => {
          finishPromotion = resolve;
        }),
    );
    const redisClient: GymDuplicateReportRedisClient = {
      set: setSpy,
      eval: vi.fn().mockResolvedValue(1),
    };
    await acquireGymDuplicateReportClaim(
      key,
      createDependencies({ connected: false, now: () => now, tokens: ['delayed-owner'] }),
    );

    const reconciliation = reconcileGymDuplicateReportClaims(redisClient, () => now);
    await vi.waitFor(() => expect(setSpy).toHaveBeenCalledTimes(1));
    now += 2 * 60 * 60 * 1000;

    expect(setSpy).toHaveBeenCalledExactlyOnceWith(key, 'delayed-owner', 'PXAT', originalExpiresAt, 'NX');
    finishPromotion?.('OK');
    await reconciliation;
  });

  it('releases a promoted owner when Redis writes the claim and then throws', async () => {
    const key = 'gymDuplicateReport:test:ambiguous-promotion';
    const redisClient = new FakeRedisClaimClient();
    redisClient.throwAfterNextSet = true;
    const outageResult = await acquireGymDuplicateReportClaim(
      key,
      createDependencies({ connected: false, tokens: ['ambiguous-promotion-owner'] }),
    );
    if (outageResult.status !== 'acquired') throw new Error('Expected a local outage claim');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    await reconcileGymDuplicateReportClaims(redisClient);
    expect(redisClient.claims.get(key)?.ownerToken).toBe('ambiguous-promotion-owner');

    await releaseGymDuplicateReportClaim(outageResult.claim);
    expect(redisClient.claims.has(key)).toBe(false);
    warnSpy.mockRestore();
  });

  it('does not release another Redis owner after a promotion conflict', async () => {
    const key = 'gymDuplicateReport:test:conflicting-owner-release';
    const redisClient = new FakeRedisClaimClient();
    const outageResult = await acquireGymDuplicateReportClaim(
      key,
      createDependencies({ connected: false, tokens: ['local-owner'] }),
    );
    if (outageResult.status !== 'acquired') throw new Error('Expected a local outage claim');
    redisClient.claims.set(key, {
      ownerToken: 'other-owner',
      expiresAt: Date.now() + 60_000,
    });

    await reconcileGymDuplicateReportClaims(redisClient);
    await releaseGymDuplicateReportClaim(outageResult.claim);

    expect(redisClient.claims.get(key)?.ownerToken).toBe('other-owner');
  });

  it('waits for an in-flight promotion before owner-checked release', async () => {
    const key = 'gymDuplicateReport:test:promotion-release-race';
    let finishPromotion: ((result: 'OK') => void) | undefined;
    const evalSpy = vi.fn().mockResolvedValue(1);
    const setSpy = vi.fn(
      () =>
        new Promise<'OK'>((resolve) => {
          finishPromotion = resolve;
        }),
    );
    const redisClient: GymDuplicateReportRedisClient = {
      set: setSpy,
      eval: evalSpy,
    };
    const outageResult = await acquireGymDuplicateReportClaim(
      key,
      createDependencies({ connected: false, tokens: ['racing-owner'] }),
    );
    if (outageResult.status !== 'acquired') throw new Error('Expected a local outage claim');

    const promotion = reconcileGymDuplicateReportClaims(redisClient);
    await vi.waitFor(() => expect(setSpy).toHaveBeenCalledTimes(1));
    const release = releaseGymDuplicateReportClaim(outageResult.claim);
    expect(evalSpy).not.toHaveBeenCalled();

    finishPromotion?.('OK');
    await promotion;
    await release;
    expect(evalSpy).toHaveBeenCalledExactlyOnceWith(expect.any(String), 1, key, 'racing-owner');
  });
});

describe('gym duplicate report claim against test Redis', () => {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const exactKeysToClean = new Set<string>();

  beforeAll(async () => {
    await redis.connect();
  });

  afterAll(async () => {
    if (exactKeysToClean.size > 0) {
      await redis.del(...exactKeysToClean);
    }
    await redis.quit();
  });

  function realRedisClaimClient(): GymDuplicateReportRedisClient {
    return {
      set: (claimKey, token, expiryMode, expiry, condition) =>
        redis.set(claimKey, token, expiryMode, expiry, condition),
      eval: (script, numberOfKeys, claimKey, token) => redis.eval(script, numberOfKeys, claimKey, token),
    };
  }

  it('enforces NX, TTL, and owner-checked release on one exact key', async () => {
    const key = gymDuplicateReportClaimKey(uuidv4(), uuidv4());
    exactKeysToClean.add(key);
    const firstOwnerToken = uuidv4();
    const duplicateOwnerToken = uuidv4();
    const successorOwnerToken = uuidv4();
    const redisClient = realRedisClaimClient();
    const firstDependencies = createDependencies({ connected: true, redisClient, tokens: [firstOwnerToken] });

    const firstClaimResult = await acquireGymDuplicateReportClaim(key, firstDependencies);
    expect(firstClaimResult.status).toBe('acquired');
    if (firstClaimResult.status !== 'acquired') throw new Error('Expected the first real Redis claim');
    expect(await redis.get(key)).toBe(firstOwnerToken);
    expect(await redis.ttl(key)).toBeGreaterThanOrEqual(GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS - 5);
    expect(await redis.ttl(key)).toBeLessThanOrEqual(GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS);

    resetGymDuplicateReportClaimsForTests();
    const duplicateDependencies = createDependencies({ connected: true, redisClient, tokens: [duplicateOwnerToken] });
    await expect(acquireGymDuplicateReportClaim(key, duplicateDependencies)).resolves.toEqual({
      status: 'already_claimed',
    });
    expect(await redis.get(key)).toBe(firstOwnerToken);

    await redis.del(key);
    const successorDependencies = createDependencies({ connected: true, redisClient, tokens: [successorOwnerToken] });
    const successorClaimResult = await acquireGymDuplicateReportClaim(key, successorDependencies);
    expect(successorClaimResult.status).toBe('acquired');
    if (successorClaimResult.status !== 'acquired') throw new Error('Expected the successor real Redis claim');
    expect(await redis.get(key)).toBe(successorOwnerToken);

    await releaseGymDuplicateReportClaim(firstClaimResult.claim);
    expect(await redis.get(key)).toBe(successorOwnerToken);

    await releaseGymDuplicateReportClaim(successorClaimResult.claim);
    expect(await redis.exists(key)).toBe(0);
    exactKeysToClean.delete(key);
  });

  it('promotes an outage claim with its original absolute expiry and suppresses another process', async () => {
    let now = Date.now();
    const originalExpiresAt = now + GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS * 1000;
    const key = gymDuplicateReportClaimKey(uuidv4(), uuidv4());
    exactKeysToClean.add(key);
    const redisClient = realRedisClaimClient();
    const outageOwner = uuidv4();
    const outageResult = await acquireGymDuplicateReportClaim(
      key,
      createDependencies({ connected: false, now: () => now, tokens: [outageOwner] }),
    );
    if (outageResult.status !== 'acquired') throw new Error('Expected a local outage claim');

    now += 75 * 60 * 1000;
    await reconcileGymDuplicateReportClaims(redisClient, () => now);
    expect(await redis.get(key)).toBe(outageOwner);
    expect(await redis.pexpiretime(key)).toBe(originalExpiresAt);

    resetGymDuplicateReportClaimsForTests();
    await expect(
      acquireGymDuplicateReportClaim(
        key,
        createDependencies({ connected: true, redisClient, now: () => now, tokens: [uuidv4()] }),
      ),
    ).resolves.toEqual({ status: 'already_claimed' });

    await releaseGymDuplicateReportClaim(outageResult.claim);
    expect(await redis.exists(key)).toBe(0);
    exactKeysToClean.delete(key);
  });
});
