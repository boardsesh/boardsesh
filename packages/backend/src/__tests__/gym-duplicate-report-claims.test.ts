import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  acquireGymDuplicateReportClaim,
  GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS,
  gymDuplicateReportClaimKey,
  releaseGymDuplicateReportClaim,
  resetGymDuplicateReportClaimsForTests,
  type GymDuplicateReportClaimDependencies,
  type GymDuplicateReportRedisClient,
} from '../utils/gym-duplicate-report-claims';

class FakeRedisClaimClient implements GymDuplicateReportRedisClient {
  readonly claims = new Map<string, string>();
  throwAfterNextSet = false;

  async set(
    key: string,
    ownerToken: string,
    _expiryMode: 'EX',
    _ttlSeconds: number,
    _condition: 'NX',
  ): Promise<'OK' | null> {
    if (this.claims.has(key)) return null;
    this.claims.set(key, ownerToken);
    if (this.throwAfterNextSet) {
      this.throwAfterNextSet = false;
      throw new Error('connection closed after write');
    }
    return 'OK';
  }

  async eval(_script: string, _numberOfKeys: number, key: string, ownerToken: string): Promise<number> {
    if (this.claims.get(key) !== ownerToken) return 0;
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

  it('keeps the Redis claim authoritative after process-local state resets', async () => {
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
    expect(redisClient.claims.get(key)).toBe('first-owner');
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
    expect(redisClient.claims.get(key)).toBe('successor-owner');
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
    expect(redisClient.claims.get(key)).toBe('ambiguous-owner');

    await releaseGymDuplicateReportClaim(firstResult.claim);
    expect(redisClient.claims.has(key)).toBe(false);

    const retryDependencies = createDependencies({ connected: true, redisClient, tokens: ['retry-owner'] });
    await expect(acquireGymDuplicateReportClaim(key, retryDependencies)).resolves.toMatchObject({
      status: 'acquired',
    });
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

  it('enforces NX, TTL, and owner-checked release on one exact key', async () => {
    const key = gymDuplicateReportClaimKey(uuidv4(), uuidv4());
    exactKeysToClean.add(key);
    const firstOwnerToken = uuidv4();
    const duplicateOwnerToken = uuidv4();
    const successorOwnerToken = uuidv4();
    const redisClient: GymDuplicateReportRedisClient = {
      set: (claimKey, token, expiryMode, ttlSeconds, condition) =>
        redis.set(claimKey, token, expiryMode, ttlSeconds, condition),
      eval: (script, numberOfKeys, claimKey, token) => redis.eval(script, numberOfKeys, claimKey, token),
    };
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
});
