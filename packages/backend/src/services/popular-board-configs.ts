/**
 * The popular board configs: the www home rail, the mobile Boards tab and the
 * sitemap's boards shard all read this list through `popularBoardConfigs`.
 *
 * How the value moves:
 *
 * - **Readers never run the statement.** `getPopularConfigs` answers from Redis,
 *   or from this process's last-seen copy, or with `[]`. A miss only asks the
 *   job queue for a refresh.
 * - **One scheduled job computes it.** `POPULAR_BOARD_CONFIGS_REFRESH_QUEUE`
 *   runs daily (and on a reader's miss), takes a cross-replica Redis lock, and
 *   SETs the new list over the old one. A failed run leaves the old list in
 *   place.
 * - **A deploy changes nothing.** The boot used to DELETE the key and re-run the
 *   statement on every replica. In production that was 24 runs at a 548 s mean
 *   in one day, several at once.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { rowsFromResult } from '@boardsesh/db/client';
import { POPULAR_BOARD_CONFIGS_REFRESH_QUEUE } from '@boardsesh/db/job-queue-schema';
import { db } from '../db/client';
import { redisClientManager } from '../redis/client';
import { logger } from '../utils/logger';
import { singleFlight } from '../utils/single-flight';
import { getJobQueue } from './job-queue';

export type CachedPopularConfig = {
  boardType: string;
  layoutId: number;
  layoutName: string | null;
  sizeId: number;
  sizeName: string | null;
  sizeDescription: string | null;
  setIds: number[];
  setNames: string[];
  climbCount: number;
  totalAscents: number;
  boardCount: number;
  displayName: string;
};

const BOARD_TYPE_LABELS: Record<string, string> = {
  kilter: 'Kilter',
  tension: 'Tension',
  moonboard: 'MoonBoard',
  decoy: 'Decoy',
  touchstone: 'Touchstone',
  grasshopper: 'Grasshopper',
  soill: 'So iLL',
  woods: 'Woods',
  // Only ever a lookup here — `formatDisplayName` reads it for one board type.
  // Spray configs never reach this map anyway: `runPopularConfigsQuery` drops
  // them (see EXCLUDED_POPULAR_CONFIG_BOARD_TYPES).
  spray: 'Spray wall',
};

const GENERIC_SETS = new Set(['bolt ons', 'screw ons', 'foot set', 'plastic', 'wood']);

function formatDisplayName(
  boardType: string,
  layoutName: string | null,
  sizeName: string | null,
  setNames: string[],
): string {
  const boardLabel = BOARD_TYPE_LABELS[boardType] || boardType;

  // Shorten layout name: strip board type, "Board", abbreviations
  const shortLayout = (layoutName || '')
    .replace(new RegExp(`\\b${boardLabel}\\b\\s*`, 'gi'), '')
    .replace(/\bBoard\b\s*/gi, '')
    .replace(/\bHomewall\b/gi, 'HW')
    .replace(/\bOriginal\b/gi, 'OG')
    .replace(/\bLayout\b/gi, '')
    .replace(/^2\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Compact size name: strip "high"/"wide", collapse whitespace around "x"
  const shortSize = (sizeName || '')
    .replace(/\s*high\s*/gi, '')
    .replace(/\s*wide\s*/gi, '')
    .replace(/\s*x\s*/g, 'x')
    .replace(/\s+/g, ' ')
    .trim();

  // Detect distinctive sets (Mainline/Auxiliary vs generic Bolt Ons/Screw Ons)
  const distinctiveSets = setNames.filter((s) => !GENERIC_SETS.has(s.toLowerCase()));
  const hasMainline = distinctiveSets.some((s) => /mainline/i.test(s) && !/kickboard/i.test(s));
  const hasAux = distinctiveSets.some((s) => /auxiliary/i.test(s) && !/kickboard/i.test(s));
  let setLabel = '';
  if (hasMainline && hasAux) {
    setLabel = ' Full Ride';
  } else if (distinctiveSets.length > 0) {
    setLabel = ` ${distinctiveSets.map((s) => s.replace(/\bKickboard\b/gi, 'KB')).join(' + ')}`;
  }

  return `${shortLayout} ${shortSize}${setLabel}`.trim();
}

/**
 * Board types that never appear in the popular-config list.
 *
 * This list is the www homepage board rail (`popular-board-rail.tsx`) and the
 * mobile Boards tab (`usePopularBoardConfigs`), so a row here is a board offered
 * to every visitor. A spray wall is one climber's own wall — private by default,
 * created through the add-a-wall flow — so it is not a board anyone browses to.
 *
 * The display-filter `SUPPORTED_BOARDS` in `@boardsesh/board-config` makes the
 * same exclusion for the pickers, but it is not the right list to import here:
 * it also gates MoonBoard on a feature flag, and flipping that flag must not
 * silently empty the rail of MoonBoard configs.
 *
 * SW-04 (#5437) must also create spray catalogue rows with `is_listed = false`
 * on `board_layouts`, `board_product_sizes` and
 * `board_product_sizes_layouts_sets`, so the query below never builds the
 * expensive LATERAL for a wall in the first place. This filter is the belt to
 * that suspenders: a single mis-seeded row must not put someone's wall on the
 * homepage.
 */
const EXCLUDED_POPULAR_CONFIG_BOARD_TYPES: ReadonlySet<string> = new Set(['spray']);

/** Whether one raw popular-config row may be published to the rail. */
export function isPopularConfigRow(row: { board_type?: unknown }): boolean {
  return !EXCLUDED_POPULAR_CONFIG_BOARD_TYPES.has(String(row.board_type));
}

/** One list for the whole cluster. The key name predates the job; keeping it means a deploy reads the value the old code wrote. */
export const POPULAR_CONFIGS_REDIS_KEY = 'boardsesh:popular-board-configs';
/**
 * A safety net, not the freshness rule. The daily job overwrites the value long
 * before this runs out; the TTL only matters if the job stops for a year.
 */
const POPULAR_CONFIGS_REDIS_TTL_SECONDS = 365 * 24 * 60 * 60;
export const POPULAR_CONFIGS_LOCK_KEY = 'boardsesh:popular-board-configs:lock';
/**
 * Longer than any run on record. The old statement averaged 548 s in production
 * and a lock shorter than the run let a second replica start its own copy; the
 * current one takes about 30 s for all configs. pg-boss's `exclusive` queue
 * policy already keeps a second job from starting, so this lock guards the
 * case it cannot see: a job pg-boss expired while its handler still runs.
 */
export const POPULAR_CONFIGS_LOCK_TTL_SECONDS = 900;
/** Once a day at 04:17 UTC, a quiet hour for every region we serve. */
export const POPULAR_CONFIGS_REFRESH_CRON = '17 4 * * *';
/**
 * How often one process may ask the queue for a refresh after a miss. The
 * queue's `exclusive` policy drops duplicates anyway; this keeps a burst of
 * home-page renders from turning into a burst of INSERTs that get dropped.
 */
const REFRESH_REQUEST_INTERVAL_MS = 60_000;
/** One refresh per process at a time; the Redis lock covers the cluster. */
const POPULAR_CONFIGS_FLIGHT_KEY = 'popular-board-configs-refresh';

const RELEASE_LOCK_IF_OWNER_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

/**
 * The last list this process saw, from Redis or from its own refresh. A reader
 * falls back to it when Redis has no value or cannot be reached, and it is the
 * only copy a deployment with no Redis (local dev, the e2e stack) has.
 */
let lastKnownConfigs: CachedPopularConfig[] | null = null;
let lastRefreshRequestAt = Number.NEGATIVE_INFINITY;

/** Test-only: forget the process-local copy and the refresh throttle. */
export function resetPopularConfigsForTests(): void {
  lastKnownConfigs = null;
  lastRefreshRequestAt = Number.NEGATIVE_INFINITY;
}

/**
 * The popular configs, without ever running the statement.
 *
 * Redis first. On a miss, the last list this process saw, or `[]`, plus a
 * request for the refresh job. Every consumer already copes with `[]`: the
 * rail hides, the mobile tab shows its empty state, and the sitemap treats it
 * as a failed fetch.
 */
export async function getPopularConfigs(): Promise<CachedPopularConfig[]> {
  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      const cached = await publisher.get(POPULAR_CONFIGS_REDIS_KEY);
      if (cached) {
        const configs = JSON.parse(cached) as CachedPopularConfig[];
        lastKnownConfigs = configs;
        return configs;
      }
    } catch (err) {
      // Redis is unreachable, which says nothing about the value. Serve what we
      // have and let the next read try again.
      logger.error('[PopularConfigs] Redis read failed:', err);
      return lastKnownConfigs ?? [];
    }
    // The key is gone (a fresh Redis, or an eviction). Ask for a refresh even
    // when this process still has a copy, or the cluster never gets one back.
    requestPopularConfigsRefresh();
    return lastKnownConfigs ?? [];
  }

  if (lastKnownConfigs) return lastKnownConfigs;
  requestPopularConfigsRefresh();
  return [];
}

/**
 * Queue one refresh. Fire-and-forget: a reader never waits on it. Without a
 * running job queue (servers started by tests) this does nothing.
 */
function requestPopularConfigsRefresh(): void {
  const now = Date.now();
  if (now - lastRefreshRequestAt < REFRESH_REQUEST_INTERVAL_MS) return;
  const boss = getJobQueue();
  if (!boss) return;
  lastRefreshRequestAt = now;
  boss.send(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, {}).catch((err: unknown) => {
    logger.error('[PopularConfigs] Could not queue a refresh:', err);
  });
}

type RefreshLock = { kind: 'held'; token: string } | { kind: 'no-redis' } | { kind: 'busy' };

async function acquireRefreshLock(): Promise<RefreshLock> {
  if (!redisClientManager.isRedisConnected()) return { kind: 'no-redis' };
  const { publisher } = redisClientManager.getClients();
  const token = randomUUID();
  const acquired = await publisher.set(POPULAR_CONFIGS_LOCK_KEY, token, 'EX', POPULAR_CONFIGS_LOCK_TTL_SECONDS, 'NX');
  return acquired ? { kind: 'held', token } : { kind: 'busy' };
}

async function releaseRefreshLock(lock: RefreshLock): Promise<void> {
  if (lock.kind !== 'held' || !redisClientManager.isRedisConnected()) return;
  try {
    const { publisher } = redisClientManager.getClients();
    // Compare-and-delete: a run that outlived its lock must not free the next
    // run's lock.
    await publisher.eval(RELEASE_LOCK_IF_OWNER_SCRIPT, 1, POPULAR_CONFIGS_LOCK_KEY, lock.token);
  } catch (err) {
    logger.error('[PopularConfigs] Lock release failed; it expires on its own:', err);
  }
}

/**
 * Compute the list and write it over the old one. The body of the refresh job.
 *
 * Returns the new list, or `null` when another replica holds the lock. Throws
 * when the statement or the Redis write fails, so pg-boss records the failure
 * and retries; the old value stays in Redis either way.
 */
export function refreshPopularConfigsCache(): Promise<CachedPopularConfig[] | null> {
  return singleFlight(POPULAR_CONFIGS_FLIGHT_KEY, async () => {
    const lock = await acquireRefreshLock();
    if (lock.kind === 'busy') {
      logger.info('[PopularConfigs] Another replica is refreshing, skipping');
      return null;
    }
    try {
      const startedAt = Date.now();
      const configs = await runPopularConfigsQuery();
      if (configs.length === 0) {
        // An empty catalogue read is a broken read, not an empty catalogue.
        // Keep serving the old list rather than blanking the rail.
        logger.warn('[PopularConfigs] Refresh returned no configs; keeping the previous list');
        return null;
      }
      if (lock.kind === 'held') {
        const { publisher } = redisClientManager.getClients();
        await publisher.set(
          POPULAR_CONFIGS_REDIS_KEY,
          JSON.stringify(configs),
          'EX',
          POPULAR_CONFIGS_REDIS_TTL_SECONDS,
        );
      }
      lastKnownConfigs = configs;
      logger.info(`[PopularConfigs] Refreshed ${configs.length} configs in ${Date.now() - startedAt} ms`);
      return configs;
    } finally {
      await releaseRefreshLock(lock);
    }
  });
}

/**
 * Register the daily refresh on the job queue. The queue itself is created by
 * the migrator (`initializeJobQueueSchema`) with the `exclusive` policy, so the
 * cron and any number of on-miss requests collapse to one queued-or-running job.
 */
export async function startPopularBoardConfigsRefresh(boss: PgBoss): Promise<void> {
  await boss.schedule(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, POPULAR_CONFIGS_REFRESH_CRON, null, { tz: 'UTC' });
  await boss.work(POPULAR_BOARD_CONFIGS_REFRESH_QUEUE, async () => {
    await refreshPopularConfigsCache();
  });
}

async function runPopularConfigsQuery(): Promise<CachedPopularConfig[]> {
  // Every listed per-size config, with the climbs that fit it: inside the
  // size's edges, and needing only sets the config has.
  //
  // "Needs only sets the config has" is `required_set_ids <@ set_ids`, the
  // same test the config's list page applies, so the count on the rail is the
  // count behind the tap. This used to be a NOT EXISTS over every hold's
  // placement (board_climb_holds x board_placements). Measured on the
  // production replica (2026-09-26), per config:
  //
  //   tension 10/8     10,131 ms -> 366 ms cold, 947k -> 114k buffers
  //   kilter 8/24       9,142 ms -> 226 ms cold
  //   grasshopper 1/5     611 ms -> 233 ms
  //
  // About 30 s for every config together, where the old statement averaged
  // 548 s in production. Counts moved by up to ~2% per config, all toward the
  // list page: the old test counted climbs with no holds rows at all (NOT
  // EXISTS over nothing is true) and dropped climbs with a junk `hold_id = 0`
  // row.
  //
  // A NULL required_set_ids means the sets were not derived yet. The list page
  // (`create-climb-filters.ts`) drops such a climb on every board but MoonBoard,
  // whose backfill runs separately and which it lets through; this count
  // follows the same rule so it still matches the list behind the tap.
  const result = await db.execute(sql`
    SELECT
      configs.board_type,
      configs.layout_id,
      bl.name AS layout_name,
      configs.size_id,
      bps.name AS size_name,
      bps.description AS size_description,
      configs.set_ids,
      configs.set_names,
      COALESCE(cc.climb_count, 0) AS climb_count,
      COALESCE(cc.total_ascents, 0) AS total_ascents,
      COALESCE(ub_counts.board_count, 0) AS board_count
    FROM (
      SELECT
        psls.board_type,
        psls.layout_id,
        psls.product_size_id AS size_id,
        array_agg(DISTINCT psls.set_id ORDER BY psls.set_id) AS set_ids,
        array_agg(DISTINCT bs.name ORDER BY bs.name) AS set_names
      FROM board_product_sizes_layouts_sets psls
      JOIN board_sets bs ON bs.board_type = psls.board_type AND bs.id = psls.set_id
      WHERE psls.is_listed = true
        -- A spray wall is one climber's own wall, never a board on the rail.
        -- Dropped here so the LATERAL climb count below is never built for one;
        -- isPopularConfigRow repeats it on the way out.
        AND psls.board_type <> 'spray'
      GROUP BY psls.board_type, psls.layout_id, psls.product_size_id
    ) configs
    JOIN board_layouts bl ON bl.board_type = configs.board_type AND bl.id = configs.layout_id
    JOIN board_product_sizes bps ON bps.board_type = configs.board_type AND bps.id = configs.size_id
    LEFT JOIN (
      SELECT
        ub.board_type,
        ub.layout_id,
        ub.size_id,
        COUNT(*)::int AS board_count
      FROM user_boards ub
      WHERE ub.deleted_at IS NULL
      GROUP BY ub.board_type, ub.layout_id, ub.size_id
    ) ub_counts
      ON ub_counts.board_type = configs.board_type
      AND ub_counts.layout_id = configs.layout_id
      AND ub_counts.size_id = configs.size_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT bc.uuid)::int AS climb_count,
        COALESCE(SUM(bcs.ascensionist_count), 0)::int AS total_ascents
      FROM board_climbs bc
      LEFT JOIN board_climb_stats bcs
        ON bcs.board_type = bc.board_type AND bcs.climb_uuid = bc.uuid
      WHERE bc.board_type = configs.board_type
        AND bc.layout_id = configs.layout_id
        AND bc.is_listed = true
        AND bc.is_draft = false
        -- The number this config advertises must match what its /list page will
        -- actually hand back, and that page filters hidden climbs out.
        AND bc.is_hidden = false
        AND bc.edge_left > bps.edge_left
        AND bc.edge_right < bps.edge_right
        AND bc.edge_bottom > bps.edge_bottom
        AND bc.edge_top < bps.edge_top
        AND (
          bc.required_set_ids <@ configs.set_ids
          OR (bc.required_set_ids IS NULL AND configs.board_type = 'moonboard')
        )
    ) cc ON true
    WHERE bl.is_listed = true
      AND bps.is_listed = true
    ORDER BY board_count DESC, total_ascents DESC, configs.board_type, bl.name
  `);

  const rows = rowsFromResult<Record<string, unknown>>(result);

  return rows.filter(isPopularConfigRow).map((row) => {
    const boardType = row.board_type as string;
    const layoutName = (row.layout_name as string) ?? null;
    const sizeName = (row.size_name as string) ?? null;
    const setNames = row.set_names as string[];
    return {
      boardType,
      layoutId: Number(row.layout_id),
      layoutName,
      sizeId: Number(row.size_id),
      sizeName,
      sizeDescription: (row.size_description as string) ?? null,
      setIds: (row.set_ids as number[]).map(Number),
      setNames,
      climbCount: Number(row.climb_count),
      totalAscents: Number(row.total_ascents),
      boardCount: Number(row.board_count),
      displayName: formatDisplayName(boardType, layoutName, sizeName, setNames),
    };
  });
}
