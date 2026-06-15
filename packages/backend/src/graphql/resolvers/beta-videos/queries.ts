import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { eq, and, desc, isNotNull, like, or, sql } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import { fetchInstagramMeta, getInstagramMediaId, isInstagramUrl } from '../../../lib/instagram-meta';
import { fetchTikTokMeta, getTikTokCacheId, isTikTokUrl } from '../../../lib/tiktok-meta';
import {
  cacheInstagramThumbnail,
  cacheTikTokThumbnail,
  getDevProxyThumbnailUrl,
  isOurS3Url,
  isS3Configured,
  STATIC_THUMBNAIL_PREFIX,
} from '../../../lib/beta-link-thumbnails';
import { redisClientManager } from '../../../redis/client';
import { logger } from '../../../utils/logger';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { applyRateLimit, requireAuthenticated } from '../shared/helpers';

type BetaLinkResult = {
  climbUuid: string;
  link: string;
  foreignUsername: string | null;
  angle: number | null;
  thumbnail: string | null;
  isListed: boolean | null;
  createdAt: string | null;
  tickUuid: string | null;
  boardId: number | null;
};

type RecentBetaLinkResult = {
  betaLink: BetaLinkResult;
  climbName: string | null;
  boardType: string;
  layoutId: number | null;
};

type BetaLinkPreviewResult = {
  link: string;
  thumbnail: string | null;
  username: string | null;
  caption: string | null;
};

const RECENT_BETA_LINKS_MAX_LIMIT = 50;
const RECENT_BETA_LINKS_DEFAULT_LIMIT = 20;
const USER_BETA_LINKS_MAX_LIMIT = 100;
const USER_BETA_LINKS_DEFAULT_LIMIT = 50;
// Cap rows per foreign_username on the home slider so a single climber's
// bulk upload doesn't push the rest of the community off the strip. NULL
// usernames are uncapped per product direction (per-user issue is the
// known-handle case).
const HOME_PER_USER_CAP = 3;

// Aggressive caching for the home-strip query: it runs a window function
// over the full beta-links table joined to board_climbs, which was slow
// enough in production to starve the DB connection pool (see incident
// triggered by the previous merge of this PR). Mirrors the strategy in
// resolvers/social/boards.ts (`warmPopularConfigsCache`): a Redis key
// with a long TTL refreshed at deploy via a distributed lock, plus
// invalidation on writes for snappier feedback.
//
// Cache key is intentionally parameter-free — we store the unfiltered,
// uncapped (post-window-cap) row set and let the resolver slice by
// `limit` + filter by `boardType` in JavaScript. One cache key covers
// every caller.
const RECENT_BETA_LINKS_REDIS_KEY = 'boardsesh:recent-beta-links';
// 24 h TTL: beta-link content rotates faster than popular-board catalog,
// but writes bust the cache anyway. TTL is the safety net, not the
// primary freshness mechanism.
const RECENT_BETA_LINKS_REDIS_TTL_SECONDS = 24 * 60 * 60;
const RECENT_BETA_LINKS_REDIS_LOCK_KEY = 'boardsesh:recent-beta-links:lock';
const RECENT_BETA_LINKS_REDIS_LOCK_TTL_SECONDS = 120;
// Cache up to 2x the public max so JS-side `boardType` filtering still has
// headroom and a single boardType call can return MAX_LIMIT rows.
const RECENT_BETA_LINKS_CACHE_SIZE = RECENT_BETA_LINKS_MAX_LIMIT * 2;

// Extract an Instagram handle from `userProfiles.instagramUrl`. The field
// holds a profile URL — we only want the handle so we can match against
// `board_beta_links.foreign_username`. Returns null for anything that
// doesn't look like a recognisable instagram.com profile URL.
function extractInstagramHandle(profileUrl: string | null): string | null {
  if (!profileUrl) return null;
  const trimmed = profileUrl.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)\/?/i);
  return match ? match[1] : null;
}

// We never surface KayaClimb beta links — we don't want to drive traffic to a
// competing climbing app from our slider. Filter them out at the resolver.
const KAYACLIMB_HOST = /^https?:\/\/(?:[a-z0-9-]+\.)*kayaclimb\.com\//i;

function isKayaClimbUrl(url: string): boolean {
  return KAYACLIMB_HOST.test(url);
}

type Row = typeof dbSchema.boardBetaLinks.$inferSelect;

type MetaResult =
  | { status: 'ok'; thumbnail: string; username: string | null }
  | { status: 'gone' }
  | { status: 'transient_error' };

type EnrichConfig = {
  fetchMeta: (url: string) => Promise<MetaResult>;
  cacheThumbnail: (cacheId: string, sourceUrl: string) => Promise<string | null>;
  getCacheId: (url: string) => string | null;
};

const INSTAGRAM_ENRICH: EnrichConfig = {
  fetchMeta: fetchInstagramMeta,
  cacheThumbnail: cacheInstagramThumbnail,
  getCacheId: getInstagramMediaId,
};

const TIKTOK_ENRICH: EnrichConfig = {
  fetchMeta: fetchTikTokMeta,
  cacheThumbnail: cacheTikTokThumbnail,
  getCacheId: getTikTokCacheId,
};

const ENRICH_CONCURRENCY = 5;

function passthroughResult(row: Row): BetaLinkResult {
  return {
    climbUuid: row.climbUuid,
    link: row.link,
    foreignUsername: row.foreignUsername,
    angle: row.angle,
    thumbnail: isOurS3Url(row.thumbnail) ? row.thumbnail : null,
    isListed: row.isListed,
    createdAt: row.createdAt,
    tickUuid: row.tickUuid,
    boardId: row.boardId,
  };
}

async function persistEnriched(row: Row, persistedThumbnail: string | null, newUsername: string | null): Promise<void> {
  const needsDbUpdate =
    (persistedThumbnail && persistedThumbnail !== row.thumbnail) ||
    (newUsername && newUsername !== row.foreignUsername);
  if (!needsDbUpdate) return;
  try {
    await db
      .update(dbSchema.boardBetaLinks)
      .set({
        thumbnail: persistedThumbnail ?? row.thumbnail,
        foreignUsername: newUsername,
      })
      .where(
        and(
          eq(dbSchema.boardBetaLinks.boardType, row.boardType),
          eq(dbSchema.boardBetaLinks.climbUuid, row.climbUuid),
          eq(dbSchema.boardBetaLinks.link, row.link),
        ),
      );
  } catch (err) {
    logger.error('[BetaLinks] Failed to persist enriched metadata:', err);
  }
}

/**
 * Fetch live metadata + (re)cache the thumbnail to S3 if available, falling
 * back to the dev proxy. The same control flow applies to Instagram and
 * TikTok — only the platform-specific helpers passed in `cfg` differ.
 *
 * Resilience contract: once we have our own cached thumbnail for a row, the
 * UI must keep rendering it regardless of what Instagram/TikTok does. We
 * never null out a cached thumbnail because of a transient error or a
 * `gone` heuristic miss — those signals can flap when IG rate-limits us or
 * serves a login wall.
 */
async function enrichRow(row: Row, cfg: EnrichConfig): Promise<BetaLinkResult | null> {
  const haveCachedThumbnail = isOurS3Url(row.thumbnail);

  // Short-circuit: once we've cached the thumbnail we have everything we
  // need to render the slider — the live fetch would only refresh the
  // username, which is presentational. Skipping the fetch avoids an
  // open-ended refetch loop for rows that get stuck on `gone` (false
  // positives during IG login-wall responses) and rows whose meta lookup
  // never returns a username, since `gone` and `transient_error` carry no
  // username and `persistEnriched` would have nothing to write either.
  if (haveCachedThumbnail) {
    return {
      climbUuid: row.climbUuid,
      link: row.link,
      foreignUsername: row.foreignUsername,
      angle: row.angle,
      thumbnail: row.thumbnail,
      isListed: row.isListed,
      createdAt: row.createdAt,
      tickUuid: row.tickUuid,
      boardId: row.boardId,
    };
  }

  const meta = await cfg.fetchMeta(row.link);

  if (meta.status === 'gone') {
    // No cached thumbnail to fall back on — drop the row.
    return null;
  }

  if (meta.status === 'transient_error') {
    // No cached thumbnail; passthroughResult will return thumbnail: null but
    // keeps the row visible in the slider with whatever metadata we have.
    return passthroughResult(row);
  }

  // haveCachedThumbnail is necessarily false past the short-circuit above —
  // we only reach this branch on a fresh row whose meta lookup returned ok.
  const cacheId = cfg.getCacheId(row.link);
  let thumbnail: string | null = null;
  let persistedThumbnail: string | null = null;

  if (isS3Configured() && cacheId) {
    thumbnail = await cfg.cacheThumbnail(cacheId, meta.thumbnail);
    persistedThumbnail = thumbnail;
  } else if (!isS3Configured()) {
    thumbnail = getDevProxyThumbnailUrl(meta.thumbnail);
  }

  const newUsername = row.foreignUsername ?? meta.username;
  await persistEnriched(row, persistedThumbnail, newUsername);

  return {
    climbUuid: row.climbUuid,
    link: row.link,
    foreignUsername: newUsername,
    angle: row.angle,
    thumbnail,
    isListed: row.isListed,
    createdAt: row.createdAt,
    tickUuid: row.tickUuid,
    boardId: row.boardId,
  };
}

/**
 * Tiny semaphore so a climb with 50+ beta links doesn't fan out 50+
 * concurrent outbound HTTP fetches. The TTL caches in instagram-meta /
 * tiktok-meta absorb most of the pressure once the cache is warm; this
 * just keeps cold-cache batches from saturating the socket pool.
 */
function makeLimiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    if (active >= concurrency) return;
    const release = queue.shift();
    if (release) {
      active++;
      release();
    }
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      next();
    });
    try {
      return await task();
    } finally {
      active--;
      next();
    }
  };
}

async function enrichRowSafe(row: Row): Promise<BetaLinkResult | null> {
  if (isKayaClimbUrl(row.link)) return null;
  if (isInstagramUrl(row.link)) return enrichRow(row, INSTAGRAM_ENRICH);
  if (isTikTokUrl(row.link)) return enrichRow(row, TIKTOK_ENRICH);
  // Unknown platform: serve only an already-cached thumbnail (don't hot-link
  // an arbitrary URL).
  return passthroughResult(row);
}

// snake_case shape returned by the raw SQL CTE; we cache the row set in this
// form so the cache contents survive any future camelCase refactor on the
// resolver result type.
type CachedRecentBetaLinkRow = {
  board_type: string;
  climb_uuid: string;
  link: string;
  foreign_username: string | null;
  angle: number | null;
  thumbnail: string | null;
  is_listed: boolean | null;
  created_at: string | null;
  tick_uuid: string | null;
  board_id: number | null;
  climb_name: string | null;
  layout_id: number | null;
};

/**
 * Run the actual CTE that powers the home strip. Returns the unfiltered,
 * uncapped (post-window-cap) top-N rows ordered by `created_at DESC`. No
 * boardType arg — we cache one global result set and filter in JS at the
 * resolver layer.
 */
async function runRecentBetaLinksQuery(): Promise<CachedRecentBetaLinkRow[]> {
  const result = await db.execute<CachedRecentBetaLinkRow>(sql`
    WITH ranked AS (
      SELECT
        bl.board_type,
        bl.climb_uuid,
        bl.link,
        bl.foreign_username,
        bl.angle,
        bl.thumbnail,
        bl.is_listed,
        bl.created_at,
        bl.tick_uuid,
        bl.board_id,
        bc.name AS climb_name,
        bc.layout_id AS layout_id,
        ROW_NUMBER() OVER (
          PARTITION BY bl.foreign_username
          ORDER BY bl.created_at DESC
        ) AS user_rank
      FROM ${dbSchema.boardBetaLinks} bl
      LEFT JOIN ${dbSchema.boardClimbs} bc
        ON bc.board_type = bl.board_type AND bc.uuid = bl.climb_uuid
      WHERE bl.is_listed = true
        AND bl.thumbnail IS NOT NULL
        AND bl.thumbnail LIKE ${`${STATIC_THUMBNAIL_PREFIX}%`}
    )
    SELECT board_type, climb_uuid, link, foreign_username, angle, thumbnail, is_listed, created_at, tick_uuid, board_id, climb_name, layout_id
    FROM ranked
    WHERE foreign_username IS NULL OR user_rank <= ${HOME_PER_USER_CAP}
    ORDER BY created_at DESC
    LIMIT ${RECENT_BETA_LINKS_CACHE_SIZE}
  `);
  return rowsFromResult<CachedRecentBetaLinkRow>(result);
}

/**
 * Redis-cached read for the home strip. Falls through to the CTE on miss
 * and writes the result back. On Redis unavailable, runs the CTE inline
 * (same fall-through pattern as `getPopularConfigs` in social/boards.ts).
 */
async function getCachedRecentBetaLinks(): Promise<CachedRecentBetaLinkRow[]> {
  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      const cached = await publisher.get(RECENT_BETA_LINKS_REDIS_KEY);
      if (cached) {
        return JSON.parse(cached) as CachedRecentBetaLinkRow[];
      }
    } catch (err) {
      logger.error('[RecentBetaLinks] Redis read failed:', err);
    }
  }

  const rows = await runRecentBetaLinksQuery();

  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      await publisher.set(RECENT_BETA_LINKS_REDIS_KEY, JSON.stringify(rows), 'EX', RECENT_BETA_LINKS_REDIS_TTL_SECONDS);
    } catch (err) {
      logger.error('[RecentBetaLinks] Redis write failed:', err);
    }
  }
  return rows;
}

/**
 * Refresh the recent-beta-links Redis cache on server startup.
 * Mirrors `warmPopularConfigsCache`: a distributed Redis lock ensures only
 * one node across the cluster runs the underlying query; others read the
 * fresh value when the resolver runs.
 */
export async function warmRecentBetaLinksCache(): Promise<void> {
  // No Redis means there's no cache to warm — running the CTE here would
  // just discard the result. Skip the work and the log so dev/test logs
  // stay honest.
  if (!redisClientManager.isRedisConnected()) return;

  try {
    const { publisher } = redisClientManager.getClients();
    const lockAcquired = await publisher.set(
      RECENT_BETA_LINKS_REDIS_LOCK_KEY,
      '1',
      'EX',
      RECENT_BETA_LINKS_REDIS_LOCK_TTL_SECONDS,
      'NX',
    );
    if (!lockAcquired) {
      logger.info('[RecentBetaLinks] Another node is refreshing the cache, skipping');
      return;
    }
    // Winning node: delete stale cache so getCachedRecentBetaLinks() runs the SQL query
    await publisher.del(RECENT_BETA_LINKS_REDIS_KEY);
  } catch (err) {
    logger.error('[RecentBetaLinks] Redis lock failed:', err);
    return;
  }

  logger.info('[RecentBetaLinks] Refreshing cache...');
  try {
    const rows = await getCachedRecentBetaLinks();
    logger.info(`[RecentBetaLinks] Cache warmed with ${rows.length} rows`);
  } catch (err) {
    logger.error('[RecentBetaLinks] Cache warm-up failed:', err);
  }
}

/**
 * Bust the cache after a write so newly-added beta links surface on the
 * next read (instead of waiting up to the TTL). Best-effort: never throws,
 * never blocks the calling mutation.
 */
export async function invalidateRecentBetaLinksCache(): Promise<void> {
  if (!redisClientManager.isRedisConnected()) return;
  try {
    const { publisher } = redisClientManager.getClients();
    await publisher.del(RECENT_BETA_LINKS_REDIS_KEY);
  } catch (err) {
    logger.error('[RecentBetaLinks] Redis invalidation failed:', err);
  }
}

export const betaLinkQueries = {
  betaLinks: async (
    _: unknown,
    { boardType, climbUuid }: { boardType: string; climbUuid: string },
  ): Promise<BetaLinkResult[]> => {
    const rows = await db
      .select()
      .from(dbSchema.boardBetaLinks)
      .where(and(eq(dbSchema.boardBetaLinks.boardType, boardType), eq(dbSchema.boardBetaLinks.climbUuid, climbUuid)));

    const limit = makeLimiter(ENRICH_CONCURRENCY);
    const enriched = await Promise.all(rows.map((row) => limit(() => enrichRowSafe(row))));

    return enriched.filter((r): r is BetaLinkResult => r !== null);
  },

  // Live, unsaved preview of a shared Instagram/TikTok URL for the mobile share
  // flow. Returns the thumbnail/caption so the client can show the post and
  // auto-match the climb from the caption before attaching. Best-effort: a
  // private/unavailable post (or a non-IG/TikTok URL) yields null fields rather
  // than an error, so the user can still attach manually. Auth + the same 30/min
  // limit as beta-link writes guard the outbound IG/TikTok fetch. Thumbnail is
  // the platform CDN URL (not S3-cached) — it's a throwaway preview, not yet a
  // persisted beta link. Caption is Instagram-only for now.
  betaLinkPreview: async (
    _: unknown,
    { link }: { link: string },
    ctx: ConnectionContext,
  ): Promise<BetaLinkPreviewResult> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 30, 'beta-link-preview');

    const preview: BetaLinkPreviewResult = {
      link,
      thumbnail: null,
      username: null,
      caption: null,
    };

    if (isInstagramUrl(link)) {
      const meta = await fetchInstagramMeta(link);
      if (meta.status === 'ok') {
        preview.thumbnail = meta.thumbnail;
        preview.username = meta.username;
        preview.caption = meta.caption;
      }
      return preview;
    }

    if (isTikTokUrl(link)) {
      const meta = await fetchTikTokMeta(link);
      if (meta.status === 'ok') {
        preview.thumbnail = meta.thumbnail;
        preview.username = meta.username;
      }
      return preview;
    }

    return preview;
  },

  // Powers the home-screen "Fresh beta" slider. We deliberately read only
  // pre-cached rows here — fanning out the live IG/TikTok enrichment in
  // `betaLinks` across the whole table is the failure mode this resolver
  // exists to avoid.
  //
  // Window function caps rows per `foreign_username` at HOME_PER_USER_CAP so
  // a single climber's burst upload can't dominate the strip. Rows with a
  // NULL foreign_username are uncapped (per product direction — the dedup
  // problem is the known-handle case).
  //
  // Wrapped in a Redis cache (see `getCachedRecentBetaLinks` below) because
  // the underlying CTE was slow enough in production to starve the DB
  // connection pool. The cache holds the unfiltered top-N; this resolver
  // slices by `limit` and filters by `boardType` in JavaScript so every
  // call hits the same cache key.
  recentBetaLinks: async (
    _: unknown,
    { limit, boardType }: { limit?: number | null; boardType?: string | null },
  ): Promise<RecentBetaLinkResult[]> => {
    const cappedLimit = Math.min(Math.max(limit ?? RECENT_BETA_LINKS_DEFAULT_LIMIT, 1), RECENT_BETA_LINKS_MAX_LIMIT);

    const cached = await getCachedRecentBetaLinks();

    const filtered: RecentBetaLinkResult[] = [];
    for (const r of cached) {
      if (boardType && r.board_type !== boardType) continue;
      if (isKayaClimbUrl(r.link)) continue;
      // The CTE filters `thumbnail LIKE '/static/beta-link-thumbnails/%'`,
      // so every cached row's thumbnail is already on our static prefix —
      // no isOurS3Url() re-check needed in this path.
      filtered.push({
        betaLink: {
          climbUuid: r.climb_uuid,
          link: r.link,
          foreignUsername: r.foreign_username,
          angle: r.angle,
          thumbnail: r.thumbnail,
          isListed: r.is_listed,
          createdAt: r.created_at,
          tickUuid: r.tick_uuid ?? null,
          boardId: r.board_id ?? null,
        },
        climbName: r.climb_name,
        boardType: r.board_type,
        layoutId: r.layout_id ?? null,
      });
      if (filtered.length >= cappedLimit) break;
    }
    return filtered;
  },

  // Powers the profile-page "Their beta" slider. Returns videos this user
  // either added (created_by_user_id match) OR posted under the IG handle
  // parsed from their userProfiles.instagramUrl. The OR semantics also
  // surface videos someone else uploaded that point at this user's IG —
  // intentional. Pre-cached thumbnails only; no live enrichment.
  //
  // Intentionally **public**: anyone (including unauthenticated callers)
  // can enumerate a user's beta videos by userId. The data surfaces on
  // the public profile page already; the resolver doesn't expose anything
  // the page doesn't. If we ever add a "private profile" mode, gate this
  // resolver there.
  userBetaLinks: async (
    _: unknown,
    { userId, limit }: { userId: string; limit?: number | null },
  ): Promise<RecentBetaLinkResult[]> => {
    const cappedLimit = Math.min(Math.max(limit ?? USER_BETA_LINKS_DEFAULT_LIMIT, 1), USER_BETA_LINKS_MAX_LIMIT);

    // Look up the user's IG handle from their profile, if set. Independent
    // query so we don't pay the cost of a second join when no profile row
    // exists.
    const profileRows = await db
      .select({ instagramUrl: dbSchema.userProfiles.instagramUrl })
      .from(dbSchema.userProfiles)
      .where(eq(dbSchema.userProfiles.userId, userId))
      .limit(1);
    const igHandle = extractInstagramHandle(profileRows[0]?.instagramUrl ?? null);

    const rows = await db
      .select({
        betaLink: dbSchema.boardBetaLinks,
        climbName: dbSchema.boardClimbs.name,
        layoutId: dbSchema.boardClimbs.layoutId,
      })
      .from(dbSchema.boardBetaLinks)
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          eq(dbSchema.boardBetaLinks.boardType, dbSchema.boardClimbs.boardType),
          eq(dbSchema.boardBetaLinks.climbUuid, dbSchema.boardClimbs.uuid),
        ),
      )
      .where(
        and(
          eq(dbSchema.boardBetaLinks.isListed, true),
          isNotNull(dbSchema.boardBetaLinks.thumbnail),
          like(dbSchema.boardBetaLinks.thumbnail, `${STATIC_THUMBNAIL_PREFIX}%`),
          igHandle
            ? or(
                eq(dbSchema.boardBetaLinks.createdByUserId, userId),
                eq(dbSchema.boardBetaLinks.foreignUsername, igHandle),
              )
            : eq(dbSchema.boardBetaLinks.createdByUserId, userId),
        ),
      )
      .orderBy(desc(dbSchema.boardBetaLinks.createdAt))
      .limit(cappedLimit);

    return rows
      .filter((r) => !isKayaClimbUrl(r.betaLink.link))
      .map((r) => ({
        betaLink: passthroughResult(r.betaLink),
        climbName: r.climbName,
        boardType: r.betaLink.boardType,
        layoutId: r.layoutId ?? null,
      }));
  },
};
