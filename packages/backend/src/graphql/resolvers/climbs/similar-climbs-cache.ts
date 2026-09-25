import { createHash } from 'crypto';
import { redisClientManager } from '../../../redis/client';
import { logger } from '../../../utils/logger';
import { singleFlight } from '../../../utils/single-flight';
import { findSimilarClimbs, type SimilarClimbResult } from './climb-similarity';

/**
 * A shared cache and a concurrency gate in front of `findSimilarClimbs`.
 *
 * ## Why the cache moved here (#4968)
 *
 * The similar-climbs read was already cached — on the web side, in
 * `unstable_cache`. That cache is per web instance and per deploy: Next's data
 * cache is instance-local storage that a new build starts empty. Sentry counted
 * 6,922 climb-view renders losing the section to the 3 s deadline across **41
 * web releases** in fourteen days, and a cache thrown away 41 times is a cache
 * that is cold most of the time it matters.
 *
 * Behind the resolver it is neither. One Redis entry answers:
 *
 *  - both web page trees for the same climb (`/{board}/…/view/…` and
 *    `/b/{slug}/…/view/…`), across all four locales;
 *  - the browser-side fetch the front door now makes when its server read
 *    degraded, which is the same query again seconds later;
 *  - the mobile app and the play drawer, which hit this resolver directly and
 *    were never covered by anything.
 *
 * It also survives a web deploy, and it is shared by every web instance rather
 * than warmed once per instance.
 *
 * ## Why single-flight, separately from the cache
 *
 * The cache changes how OFTEN the statement runs. `singleFlight` changes how
 * many copies run AT ONCE, and per `docs/db-connectivity.md` that is the
 * property that keeps a cold window from emptying the pool: "the Redis hit rate
 * is not the safety property; the concurrency of the miss is." A crawler
 * arriving on one climb's several URLs in the same second is exactly the shape
 * #4463 documents.
 *
 * ## What this is NOT
 *
 * It is not a fix for the statement's cost, and the numbers say why it does not
 * have to be. On the dev catalogue (893k climbs, 5.5M kilter hold rows, serial
 * plan) a TYPICAL 18-hold Kilter climb runs **4 831 ms on a fresh Postgres and
 * 205 ms warm** — a 23x spread, and the cold figure is 1.6x the front door's 3 s
 * deadline. The long tail (198 holds) is 7 860 ms cold, 1 542 ms warm. So the
 * failure #4968 reports is a cold-cache failure almost by definition, and
 * keeping one warm copy somewhere shared is a proportionate answer to it.
 *
 * Making the statement itself fast is a different job and belongs to #5352. No
 * b-tree index does it: `COUNT(DISTINCT hold_id)` per candidate is a set
 * intersection, so the answer there is a set-overlap structure (a GIN-indexed
 * hold-id array per climb, or a materialised neighbour table). Nothing here
 * touches the query — a rewrite drops in behind this wrapper unchanged.
 */

/** Bump when a code change alters what this query RETURNS for an existing key. */
const CACHE_VERSION = 'v1';

/**
 * One hour, matching the web front door's own `revalidate`. The rows behind it
 * move slowly — a newly published climb changes one target's neighbours, and a
 * tick changes a candidate's ascent count — and neither is worth a shorter
 * window on a discovery section.
 */
export const SIMILAR_CLIMBS_CACHE_TTL_SECONDS = 3600;

const CACHE_KEY_PREFIX = 'boardsesh:similar-climbs';

type CachedSimilarClimbsArgs = Parameters<typeof findSimilarClimbs>[0];

/**
 * Everything that changes the answer, in a fixed order so two callers
 * describing the same request produce the same key. `holds` is sorted because
 * the resolver builds it from a row order Postgres does not promise.
 */
function buildCacheKey(args: CachedSimilarClimbsArgs): string {
  const holdIds = Array.from(new Set(args.holds.map(({ holdId }) => holdId))).sort((a, b) => a - b);
  const shape = JSON.stringify({
    holdIds,
    threshold: args.threshold,
    limit: args.limit ?? null,
    sizeId: args.sizeId ?? null,
    excludeUuid: args.excludeUuid ?? null,
    statsAngle: args.statsAngle ?? null,
  });
  const shapeHash = createHash('sha256').update(shape).digest('hex').slice(0, 32);

  return [CACHE_KEY_PREFIX, CACHE_VERSION, args.boardType, args.layoutId, shapeHash].join(':');
}

/**
 * `findSimilarClimbs`, cached in Redis and collapsed to one in-flight copy per
 * key per process.
 *
 * Every failure mode falls through to the underlying read rather than to an
 * error: an unreachable Redis must degrade this to today's behaviour, never
 * take the section down.
 *
 * Deliberately without the process-local fallback map that
 * `getCachedRecentBetaLinks` keeps for Redis-less deployments. That read has a
 * handful of scopes; this one is keyed per climb across a catalogue of nearly a
 * million, so a local map would be an unbounded cache in a long-lived process.
 * With no Redis, single-flight alone still collapses the concurrent burst,
 * which is the half that protects the pool.
 */
export async function findSimilarClimbsCached(args: CachedSimilarClimbsArgs): Promise<SimilarClimbResult[]> {
  const cacheKey = buildCacheKey(args);

  if (redisClientManager.isRedisConnected()) {
    try {
      const cached = await redisClientManager.getClients().publisher.get(cacheKey);
      if (cached) return JSON.parse(cached) as SimilarClimbResult[];
    } catch (error) {
      logger.error('[SimilarClimbs] Redis read failed:', error);
    }
  }

  return singleFlight(cacheKey, async () => {
    const rows = await findSimilarClimbs(args);

    if (redisClientManager.isRedisConnected()) {
      try {
        await redisClientManager
          .getClients()
          .publisher.set(cacheKey, JSON.stringify(rows), 'EX', SIMILAR_CLIMBS_CACHE_TTL_SECONDS);
      } catch (error) {
        logger.error('[SimilarClimbs] Redis write failed:', error);
      }
    }

    return rows;
  });
}
