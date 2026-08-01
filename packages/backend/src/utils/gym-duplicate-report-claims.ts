import { randomUUID } from 'node:crypto';
import { redisClientManager } from '../redis/client';
import { logger } from './logger';

export const GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS = 24 * 60 * 60;
const GYM_DUPLICATE_REPORT_CLAIM_TTL_MS = GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS * 1000;

const RELEASE_IF_OWNER_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

type LocalClaim = {
  ownerToken: string;
  expiresAt: number;
};

/** The narrow Redis surface needed by this claim protocol. */
export interface GymDuplicateReportRedisClient {
  set(key: string, ownerToken: string, expiryMode: 'EX', ttlSeconds: number, condition: 'NX'): Promise<'OK' | null>;
  eval(script: string, numberOfKeys: number, key: string, ownerToken: string): Promise<unknown>;
}

export interface GymDuplicateReportClaimDependencies {
  isRedisConnected: () => boolean;
  getRedisClient: () => GymDuplicateReportRedisClient;
  createOwnerToken: () => string;
  now: () => number;
}

export type GymDuplicateReportClaim = {
  key: string;
  ownerToken: string;
  redisClient: GymDuplicateReportRedisClient | null;
  redisClaimMayExist: boolean;
};

export type GymDuplicateReportClaimResult =
  | { status: 'acquired'; claim: GymDuplicateReportClaim }
  | { status: 'already_claimed' };

const localClaims = new Map<string, LocalClaim>();
let nextLocalClaimPruneAt = 0;

const defaultDependencies: GymDuplicateReportClaimDependencies = {
  isRedisConnected: () => redisClientManager.isRedisConnected(),
  getRedisClient: () => redisClientManager.getClients().publisher,
  createOwnerToken: randomUUID,
  now: Date.now,
};

function releaseLocalClaimIfOwner(key: string, ownerToken: string): boolean {
  const claim = localClaims.get(key);
  if (!claim || claim.ownerToken !== ownerToken) return false;
  localClaims.delete(key);
  return true;
}

function pruneExpiredLocalClaims(now: number): void {
  if (now < nextLocalClaimPruneAt) return;
  nextLocalClaimPruneAt = now + 60 * 60 * 1000;
  for (const [key, claim] of localClaims) {
    if (claim.expiresAt <= now) localClaims.delete(key);
  }
}

/** One stable key per unordered gym pair, so (A,B) and (B,A) de-dupe together. */
export function gymDuplicateReportClaimKey(firstUuid: string, secondUuid: string): string {
  const [lowUuid, highUuid] = [firstUuid, secondUuid].sort();
  return `gymDuplicateReport:${lowUuid}:${highUuid}`;
}

/**
 * Claim a duplicate-gym report window locally first, then across instances when
 * Redis is healthy. The local claim deliberately remains held when Redis is
 * unavailable or SET has an ambiguous outcome, so an outage cannot make one
 * instance send the same notification repeatedly.
 */
export async function acquireGymDuplicateReportClaim(
  key: string,
  dependencies: GymDuplicateReportClaimDependencies = defaultDependencies,
): Promise<GymDuplicateReportClaimResult> {
  const now = dependencies.now();
  pruneExpiredLocalClaims(now);
  const existingClaim = localClaims.get(key);
  if (existingClaim && existingClaim.expiresAt > now) {
    return { status: 'already_claimed' };
  }

  const ownerToken = dependencies.createOwnerToken();
  localClaims.set(key, {
    ownerToken,
    expiresAt: now + GYM_DUPLICATE_REPORT_CLAIM_TTL_MS,
  });

  const localOnlyClaim: GymDuplicateReportClaim = {
    key,
    ownerToken,
    redisClient: null,
    redisClaimMayExist: false,
  };

  if (!dependencies.isRedisConnected()) {
    return { status: 'acquired', claim: localOnlyClaim };
  }

  let redisClient: GymDuplicateReportRedisClient;
  try {
    redisClient = dependencies.getRedisClient();
  } catch {
    logger.warn('[GymDuplicateReport] Redis claim client unavailable; using the local de-dup window.');
    return { status: 'acquired', claim: localOnlyClaim };
  }

  try {
    const setResult = await redisClient.set(key, ownerToken, 'EX', GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS, 'NX');

    if (setResult === null) {
      releaseLocalClaimIfOwner(key, ownerToken);
      return { status: 'already_claimed' };
    }

    return {
      status: 'acquired',
      claim: { key, ownerToken, redisClient, redisClaimMayExist: true },
    };
  } catch {
    // SET may have reached Redis before the connection failed. Retain both the
    // token and client so an email failure can still attempt owner-checked cleanup.
    logger.warn('[GymDuplicateReport] Redis claim outcome unknown; using the local de-dup window.');
    return {
      status: 'acquired',
      claim: { key, ownerToken, redisClient, redisClaimMayExist: true },
    };
  }
}

/**
 * Release only the caller's own local and Redis claims. Cleanup is best-effort:
 * it must never replace the email error that caused the release.
 */
export async function releaseGymDuplicateReportClaim(claim: GymDuplicateReportClaim): Promise<void> {
  releaseLocalClaimIfOwner(claim.key, claim.ownerToken);

  if (!claim.redisClient || !claim.redisClaimMayExist) return;

  try {
    await claim.redisClient.eval(RELEASE_IF_OWNER_SCRIPT, 1, claim.key, claim.ownerToken);
  } catch {
    logger.warn('[GymDuplicateReport] Redis claim cleanup failed; the claim will expire automatically.');
  }
}

/** Clear process-local claim state between tests; Redis state is intentionally untouched. */
export function resetGymDuplicateReportClaimsForTests(): void {
  localClaims.clear();
  nextLocalClaimPruneAt = 0;
}
