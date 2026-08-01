import { randomUUID } from 'node:crypto';
import { redisClientManager } from '../redis/client';
import { logger } from './logger';

export const GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS = 24 * 60 * 60;
const GYM_DUPLICATE_REPORT_CLAIM_TTL_MS = GYM_DUPLICATE_REPORT_CLAIM_TTL_SECONDS * 1000;
const GYM_DUPLICATE_REPORT_PROMOTION_RETRY_MS = 60_000;

const RELEASE_IF_OWNER_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

type LocalClaim = {
  ownerToken: string;
  expiresAt: number;
  nextPromotionAt: number;
  generation: number;
  distributed: boolean;
  publicClaim: GymDuplicateReportClaim;
};

/** The narrow Redis surface needed by this claim protocol. */
export interface GymDuplicateReportRedisClient {
  set(key: string, ownerToken: string, expiryMode: 'PXAT', expiry: number, condition: 'NX'): Promise<'OK' | null>;
  /** ioredis exposes EVAL as unknown; cleanup deliberately ignores the Lua result. */
  eval(script: string, numberOfKeys: number, key: string, ownerToken: string): Promise<unknown>;
}

type GymDuplicateReportRedisState = {
  redisClient: GymDuplicateReportRedisClient | null;
  redisClaimMayExist: boolean;
};

export interface GymDuplicateReportClaimDependencies {
  isRedisConnected: () => boolean;
  getRedisClient: () => GymDuplicateReportRedisClient;
  createOwnerToken: () => string;
  now: () => number;
}

export type GymDuplicateReportClaim = Readonly<{
  key: string;
  ownerToken: string;
}>;

export type GymDuplicateReportClaimResult =
  | { status: 'acquired'; claim: GymDuplicateReportClaim }
  | { status: 'already_claimed' };

const localClaims = new Map<string, LocalClaim>();
const promotionPromises = new WeakMap<GymDuplicateReportClaim, Promise<void>>();
const redisStates = new WeakMap<GymDuplicateReportClaim, GymDuplicateReportRedisState>();
let nextLocalClaimPruneAt = 0;
let latestLocalClaimGeneration = 0;

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

async function promoteLocalClaim(
  key: string,
  localClaim: LocalClaim,
  redisClient: GymDuplicateReportRedisClient,
  now: () => number,
  forcePromotion: boolean,
): Promise<void> {
  if (localClaim.distributed) return;
  if (localClaims.get(key) !== localClaim) return;

  const existingPromotion = promotionPromises.get(localClaim.publicClaim);
  if (existingPromotion) {
    await existingPromotion;
    // A caller using a newly recovered client must retry after the older
    // client's in-flight promotion failed. Per-claim promise registration below
    // serializes concurrent followers, so only one follow-up SET runs.
    if (localClaim.distributed || localClaims.get(key) !== localClaim) return;
    await promoteLocalClaim(key, localClaim, redisClient, now, forcePromotion);
    return;
  }

  const promotionNow = now();
  if (localClaim.expiresAt <= promotionNow) {
    releaseLocalClaimIfOwner(key, localClaim.ownerToken);
    return;
  }
  if (!forcePromotion && localClaim.nextPromotionAt > promotionNow) return;

  // Conservatively remember the client before SET: a connection failure may
  // happen after Redis applied the write. releaseGymDuplicateReportClaim then
  // waits for this promotion and performs the same owner-checked cleanup used by
  // the normal acquisition path.
  const redisState = redisStates.get(localClaim.publicClaim);
  if (!redisState) throw new Error('Missing Redis state for gym duplicate report claim');
  redisState.redisClient = redisClient;
  redisState.redisClaimMayExist = true;

  const promotionPromise = (async () => {
    try {
      // PXAT pins Redis to the original absolute local expiry. A relative PX
      // computed before ioredis queues/retries the command would extend the
      // de-dup window by that delay.
      const setResult = await redisClient.set(key, localClaim.ownerToken, 'PXAT', localClaim.expiresAt, 'NX');
      if (setResult === 'OK' && localClaims.get(key) === localClaim) {
        localClaim.distributed = true;
      } else if (setResult === null) {
        localClaim.nextPromotionAt = Math.min(localClaim.expiresAt, now() + GYM_DUPLICATE_REPORT_PROMOTION_RETRY_MS);
      }
      // null means another distributed owner already protects this pair. Never
      // overwrite it. Keep the local claim pending so a later recovery/acquire
      // can retry after that owner releases or expires.
    } catch {
      localClaim.nextPromotionAt = Math.min(localClaim.expiresAt, now() + GYM_DUPLICATE_REPORT_PROMOTION_RETRY_MS);
      logger.warn('[GymDuplicateReport] Redis claim promotion failed; keeping the local de-dup window.');
    }
  })();
  promotionPromises.set(localClaim.publicClaim, promotionPromise);
  try {
    await promotionPromise;
  } finally {
    if (promotionPromises.get(localClaim.publicClaim) === promotionPromise) {
      promotionPromises.delete(localClaim.publicClaim);
    }
  }
}

/**
 * Copy every process-local outage claim into Redis after recovery. Each write is
 * SET NX PXAT with the claim's original absolute expiry, so reconciliation
 * neither extends the 24-hour window nor overwrites another instance's owner
 * token.
 */
export async function reconcileGymDuplicateReportClaims(
  redisClient: GymDuplicateReportRedisClient,
  now: () => number = Date.now,
  forcePromotion = true,
): Promise<void> {
  let reconciledThroughGeneration = 0;
  do {
    const snapshotGeneration = latestLocalClaimGeneration;
    // Snapshot before awaiting SET so Map mutation cannot perturb this pass.
    // The readiness path drains later generations before RedisClientManager
    // advertises connectivity; opportunistic request-path work stays bounded
    // to one snapshot and lets each connected acquire own its direct SET.
    const claimsAtStart = Array.from(localClaims.entries()).filter(
      ([, localClaim]) =>
        localClaim.generation > reconciledThroughGeneration && localClaim.generation <= snapshotGeneration,
    );
    for (const [key, localClaim] of claimsAtStart) {
      if (localClaim.expiresAt <= now()) {
        releaseLocalClaimIfOwner(key, localClaim.ownerToken);
        continue;
      }
      await promoteLocalClaim(key, localClaim, redisClient, now, forcePromotion);
    }
    reconciledThroughGeneration = snapshotGeneration;
  } while (forcePromotion && latestLocalClaimGeneration > reconciledThroughGeneration);
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
  let now = dependencies.now();
  pruneExpiredLocalClaims(now);

  let redisClient: GymDuplicateReportRedisClient | null = null;
  if (dependencies.isRedisConnected()) {
    try {
      redisClient = dependencies.getRedisClient();
      // This is normally completed by the Redis readiness hook below. It is
      // repeated opportunistically so a transient promotion failure is retried
      // on the next request while local suppression remains honest and intact.
      await reconcileGymDuplicateReportClaims(redisClient, dependencies.now, false);
      now = dependencies.now();
      pruneExpiredLocalClaims(now);
    } catch {
      logger.warn('[GymDuplicateReport] Redis claim client unavailable; using the local de-dup window.');
    }
  }

  const existingClaim = localClaims.get(key);
  if (existingClaim && existingClaim.expiresAt > now) {
    return { status: 'already_claimed' };
  }

  const ownerToken = dependencies.createOwnerToken();
  const localOnlyClaim: GymDuplicateReportClaim = Object.freeze({
    key,
    ownerToken,
  });
  const redisState: GymDuplicateReportRedisState = {
    redisClient: null,
    redisClaimMayExist: false,
  };
  redisStates.set(localOnlyClaim, redisState);
  const localClaim: LocalClaim = {
    ownerToken,
    expiresAt: now + GYM_DUPLICATE_REPORT_CLAIM_TTL_MS,
    nextPromotionAt: now,
    generation: (latestLocalClaimGeneration += 1),
    distributed: false,
    publicClaim: localOnlyClaim,
  };
  localClaims.set(key, localClaim);

  if (!redisClient) {
    return { status: 'acquired', claim: localOnlyClaim };
  }

  redisState.redisClient = redisClient;
  redisState.redisClaimMayExist = true;
  try {
    // Pin Redis to the same absolute boundary as the local claim. A relative EX
    // would start when Redis processes the command, leaving a small interval at
    // the 24-hour boundary where local state has expired but Redis still rejects
    // the next legitimate report.
    const setResult = await redisClient.set(key, ownerToken, 'PXAT', localClaim.expiresAt, 'NX');

    if (setResult === null) {
      releaseLocalClaimIfOwner(key, ownerToken);
      return { status: 'already_claimed' };
    }

    localClaim.distributed = true;

    return {
      status: 'acquired',
      claim: localOnlyClaim,
    };
  } catch {
    // SET may have reached Redis before the connection failed. Retain both the
    // token and client so an email failure can still attempt owner-checked cleanup.
    localClaim.nextPromotionAt = Math.min(
      localClaim.expiresAt,
      dependencies.now() + GYM_DUPLICATE_REPORT_PROMOTION_RETRY_MS,
    );
    logger.warn('[GymDuplicateReport] Redis claim outcome unknown; using the local de-dup window.');
    return {
      status: 'acquired',
      claim: localOnlyClaim,
    };
  }
}

/**
 * Release only the caller's own local and Redis claims. Cleanup is best-effort:
 * it must never replace the email error that caused the release.
 */
export async function releaseGymDuplicateReportClaim(claim: GymDuplicateReportClaim): Promise<void> {
  releaseLocalClaimIfOwner(claim.key, claim.ownerToken);

  // A Redis-recovery callback can race an email failure. Wait until its SET NX
  // has a definite/ambiguous outcome before owner-checked cleanup, otherwise a
  // successful late promotion could recreate the claim after release returned.
  const pendingPromotion = promotionPromises.get(claim);
  if (pendingPromotion) await pendingPromotion;

  const redisState = redisStates.get(claim);
  if (!redisState?.redisClient || !redisState.redisClaimMayExist) return;

  try {
    await redisState.redisClient.eval(RELEASE_IF_OWNER_SCRIPT, 1, claim.key, claim.ownerToken);
  } catch {
    logger.warn('[GymDuplicateReport] Redis claim cleanup failed; the claim will expire automatically.');
  }
}

/**
 * @internal Clear the shared claim index between tests. The object-keyed WeakMap
 * state intentionally survives while a test still holds an old public claim, so
 * that owner can finish its in-flight promotion or owner-checked Redis cleanup.
 * A new claim object cannot observe that state, and unreferenced entries remain
 * weakly collectible.
 */
export function resetGymDuplicateReportClaimsForTests(): void {
  localClaims.clear();
  nextLocalClaimPruneAt = 0;
  latestLocalClaimGeneration = 0;
}

// Initial startup has no outage claims, but ioredis can reconnect later while
// successful local-only notifications are still inside their 24-hour window.
// RedisClientManager runs this hook before it advertises the recovered
// connection to request handlers, closing the cross-instance duplicate gap.
redisClientManager.onRedisReady((redisClient) => reconcileGymDuplicateReportClaims(redisClient));
