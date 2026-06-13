import { v4 as uuidv4 } from 'uuid';
import { eq, and, count, isNull, sql, ilike, or, desc, inArray, like } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { normaliseSetIds } from '@boardsesh/board-config';
import { rowsFromResult } from '@boardsesh/db/client';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { consensusDifficultyExpr } from '../shared/sql-expressions';
import {
  CreateBoardInputSchema,
  UpdateBoardInputSchema,
  BoardLeaderboardInputSchema,
  MyBoardsInputSchema,
  FollowBoardInputSchema,
  SearchBoardsInputSchema,
  PopularBoardConfigsInputSchema,
  SerialNumberLookupSchema,
  RecordBoardSerialInputSchema,
  UUIDSchema,
} from '../../../validation/schemas';
import { generateUniqueGymSlug } from './gyms';
import { logger } from '../../../utils/logger';
import { redisClientManager } from '../../../redis/client';
import { isUniqueViolation } from '../../../utils/postgres-errors';

// ============================================
// Helpers
// ============================================

function throwIfBoardSerialConflict(error: unknown): void {
  if (isUniqueViolation(error, 'user_boards_unique_serial')) {
    throw new GraphQLError('That serial is already linked to another board', {
      extensions: { code: 'BOARD_SERIAL_ALREADY_LINKED' },
    });
  }
}

/**
 * Generate a unique slug from a board name.
 * Uses a single query to fetch all existing slugs that share the same prefix,
 * then picks the next available suffix in-memory — no sequential DB loop.
 */
export async function generateUniqueSlug(name: string): Promise<string> {
  const baseSlug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'board';

  // Fetch the base slug and all numeric-suffix variants in one query.
  // e.g. for "my-board" we match "my-board" and "my-board-2", "my-board-10", etc.
  const existing = await db
    .select({ slug: dbSchema.userBoards.slug })
    .from(dbSchema.userBoards)
    .where(
      and(
        or(eq(dbSchema.userBoards.slug, baseSlug), like(dbSchema.userBoards.slug, `${baseSlug}-%`)),
        isNull(dbSchema.userBoards.deletedAt),
      ),
    );

  if (existing.length === 0) {
    return baseSlug;
  }

  const taken = new Set(existing.map((r) => r.slug));

  if (!taken.has(baseSlug)) {
    return baseSlug;
  }

  for (let i = 2; i <= 100; i++) {
    const candidate = `${baseSlug}-${i}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  // Fallback: append UUID fragment
  return `${baseSlug}-${uuidv4().slice(0, 8)}`;
}

/**
 * Resolve a board ID from user + board config.
 * Used by tick logging to auto-populate boardId.
 */
export async function resolveBoardFromPath(
  userId: string,
  boardType: string,
  layoutId: number,
  sizeId: number,
  setIds: string,
): Promise<number | null> {
  const [board] = await db
    .select({ id: dbSchema.userBoards.id })
    .from(dbSchema.userBoards)
    .where(
      and(
        eq(dbSchema.userBoards.ownerId, userId),
        eq(dbSchema.userBoards.boardType, boardType),
        eq(dbSchema.userBoards.layoutId, layoutId),
        eq(dbSchema.userBoards.sizeId, sizeId),
        eq(dbSchema.userBoards.setIds, setIds),
        isNull(dbSchema.userBoards.deletedAt),
      ),
    )
    .limit(1);

  return board?.id ?? null;
}

/**
 * Enrich a board row with computed fields (counts, names, follow status).
 */
async function enrichBoard(
  board: typeof dbSchema.userBoards.$inferSelect,
  authenticatedUserId?: string,
  distanceMeters?: number | null,
) {
  // Run all independent queries in parallel to avoid N+1 per board
  const [ownerResult, tickStatsResult, followerStatsResult, commentStatsResult, followCheckResult, gymInfoResult] =
    await Promise.all([
      // Get owner profile
      db
        .select({
          name: dbSchema.users.name,
          image: dbSchema.users.image,
          displayName: dbSchema.userProfiles.displayName,
          avatarUrl: dbSchema.userProfiles.avatarUrl,
        })
        .from(dbSchema.users)
        .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
        .where(eq(dbSchema.users.id, board.ownerId))
        .limit(1),

      // Count total ascents and unique climbers
      db
        .select({
          totalAscents: count(),
          uniqueClimbers: sql<number>`COUNT(DISTINCT ${dbSchema.boardseshTicks.userId})`,
        })
        .from(dbSchema.boardseshTicks)
        .where(
          and(
            eq(dbSchema.boardseshTicks.boardId, board.id),
            or(eq(dbSchema.boardseshTicks.status, 'flash'), eq(dbSchema.boardseshTicks.status, 'send')),
          ),
        ),

      // Count followers
      db.select({ count: count() }).from(dbSchema.boardFollows).where(eq(dbSchema.boardFollows.boardUuid, board.uuid)),

      // Count comments
      db
        .select({ count: count() })
        .from(dbSchema.comments)
        .where(
          and(
            eq(dbSchema.comments.entityType, 'board'),
            eq(dbSchema.comments.entityId, board.uuid),
            isNull(dbSchema.comments.deletedAt),
          ),
        ),

      // Check if authenticated user follows this board
      authenticatedUserId
        ? db
            .select({ count: count() })
            .from(dbSchema.boardFollows)
            .where(
              and(
                eq(dbSchema.boardFollows.userId, authenticatedUserId),
                eq(dbSchema.boardFollows.boardUuid, board.uuid),
              ),
            )
        : Promise.resolve([]),

      // Get gym info if board is linked to a gym
      board.gymId
        ? db
            .select({ uuid: dbSchema.gyms.uuid, name: dbSchema.gyms.name })
            .from(dbSchema.gyms)
            .where(and(eq(dbSchema.gyms.id, board.gymId), isNull(dbSchema.gyms.deletedAt)))
            .limit(1)
        : Promise.resolve([]),
    ]);

  const ownerInfo = ownerResult[0];
  const tickStats = tickStatsResult[0];
  const followerStats = followerStatsResult[0];
  const commentStats = commentStatsResult[0];
  const isFollowedByMe = Number(followCheckResult[0]?.count || 0) > 0;
  const gymInfo = (gymInfoResult as Array<{ uuid: string; name: string }>)[0];

  return {
    id: Number(board.id),
    uuid: board.uuid,
    slug: board.slug,
    ownerId: board.ownerId,
    ownerDisplayName: ownerInfo?.displayName || ownerInfo?.name || undefined,
    ownerAvatarUrl: ownerInfo?.avatarUrl || ownerInfo?.image || undefined,
    boardType: board.boardType,
    layoutId: Number(board.layoutId),
    sizeId: Number(board.sizeId),
    setIds: board.setIds,
    name: board.name,
    description: board.description,
    locationName: board.locationName,
    latitude: board.latitude,
    longitude: board.longitude,
    isPublic: board.isPublic,
    isUnlisted: board.isUnlisted,
    hideLocation: board.hideLocation,
    isOwned: board.isOwned,
    angle: Number(board.angle),
    isAngleAdjustable: board.isAngleAdjustable,
    createdAt: board.createdAt.toISOString(),
    // Computed name fields (TODO: resolve from board-specific layout/size/set tables if needed)
    layoutName: null,
    sizeName: null,
    sizeDescription: null,
    setNames: null,
    totalAscents: Number(tickStats?.totalAscents || 0),
    uniqueClimbers: Number(tickStats?.uniqueClimbers || 0),
    followerCount: Number(followerStats?.count || 0),
    commentCount: Number(commentStats?.count || 0),
    isFollowedByMe,
    gymId: board.gymId ?? null,
    gymUuid: gymInfo?.uuid ?? null,
    gymName: gymInfo?.name ?? null,
    distanceMeters: distanceMeters ?? null,
    serialNumber: board.serialNumber ?? null,
  };
}

/**
 * Batch-enrich multiple boards with computed fields using 6 total queries
 * instead of 6 per board. Used by list endpoints to avoid N+1.
 */
async function enrichBoards(
  boards: Array<{ board: typeof dbSchema.userBoards.$inferSelect; distanceMeters?: number | null }>,
  authenticatedUserId?: string,
) {
  if (boards.length === 0) return [];

  const boardIds = boards.map((b) => b.board.id);
  const boardUuids = boards.map((b) => b.board.uuid);
  const ownerIds = [...new Set(boards.map((b) => b.board.ownerId))];
  const gymIds = [...new Set(boards.map((b) => b.board.gymId).filter((id): id is number => id != null))];

  const [ownerRows, tickRows, followerRows, commentRows, followRows, gymRows] = await Promise.all([
    // Batch owner profiles
    db
      .select({
        userId: dbSchema.users.id,
        name: dbSchema.users.name,
        image: dbSchema.users.image,
        displayName: dbSchema.userProfiles.displayName,
        avatarUrl: dbSchema.userProfiles.avatarUrl,
      })
      .from(dbSchema.users)
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
      .where(inArray(dbSchema.users.id, ownerIds)),

    // Batch tick stats per board
    db
      .select({
        boardId: dbSchema.boardseshTicks.boardId,
        totalAscents: count(),
        uniqueClimbers: sql<number>`COUNT(DISTINCT ${dbSchema.boardseshTicks.userId})`,
      })
      .from(dbSchema.boardseshTicks)
      .where(
        and(
          inArray(dbSchema.boardseshTicks.boardId, boardIds),
          or(eq(dbSchema.boardseshTicks.status, 'flash'), eq(dbSchema.boardseshTicks.status, 'send')),
        ),
      )
      .groupBy(dbSchema.boardseshTicks.boardId),

    // Batch follower counts per board
    db
      .select({
        boardUuid: dbSchema.boardFollows.boardUuid,
        count: count(),
      })
      .from(dbSchema.boardFollows)
      .where(inArray(dbSchema.boardFollows.boardUuid, boardUuids))
      .groupBy(dbSchema.boardFollows.boardUuid),

    // Batch comment counts per board
    db
      .select({
        entityId: dbSchema.comments.entityId,
        count: count(),
      })
      .from(dbSchema.comments)
      .where(
        and(
          eq(dbSchema.comments.entityType, 'board'),
          inArray(dbSchema.comments.entityId, boardUuids),
          isNull(dbSchema.comments.deletedAt),
        ),
      )
      .groupBy(dbSchema.comments.entityId),

    // Batch follow status for authenticated user
    authenticatedUserId
      ? db
          .select({ boardUuid: dbSchema.boardFollows.boardUuid })
          .from(dbSchema.boardFollows)
          .where(
            and(
              eq(dbSchema.boardFollows.userId, authenticatedUserId),
              inArray(dbSchema.boardFollows.boardUuid, boardUuids),
            ),
          )
      : Promise.resolve([]),

    // Batch gym info
    gymIds.length > 0
      ? db
          .select({ id: dbSchema.gyms.id, uuid: dbSchema.gyms.uuid, name: dbSchema.gyms.name })
          .from(dbSchema.gyms)
          .where(and(inArray(dbSchema.gyms.id, gymIds), isNull(dbSchema.gyms.deletedAt)))
      : Promise.resolve([]),
  ]);

  // Index results for O(1) lookups
  const ownerMap = new Map(ownerRows.map((r) => [r.userId, r]));
  const tickMap = new Map(tickRows.map((r) => [r.boardId, r]));
  const followerMap = new Map(followerRows.map((r) => [r.boardUuid, Number(r.count)]));
  const commentMap = new Map(commentRows.map((r) => [r.entityId, Number(r.count)]));
  const followedSet = new Set(followRows.map((r) => r.boardUuid));
  const gymMap = new Map(gymRows.map((r) => [r.id, r]));

  return boards.map(({ board, distanceMeters }) => {
    const owner = ownerMap.get(board.ownerId);
    const ticks = tickMap.get(board.id);
    const gym = board.gymId ? gymMap.get(board.gymId) : undefined;

    return {
      id: Number(board.id),
      uuid: board.uuid,
      slug: board.slug,
      ownerId: board.ownerId,
      ownerDisplayName: owner?.displayName || owner?.name || undefined,
      ownerAvatarUrl: owner?.avatarUrl || owner?.image || undefined,
      boardType: board.boardType,
      layoutId: Number(board.layoutId),
      sizeId: Number(board.sizeId),
      setIds: board.setIds,
      name: board.name,
      description: board.description,
      locationName: board.locationName,
      latitude: board.latitude,
      longitude: board.longitude,
      isPublic: board.isPublic,
      isUnlisted: board.isUnlisted,
      hideLocation: board.hideLocation,
      isOwned: board.isOwned,
      angle: Number(board.angle),
      isAngleAdjustable: board.isAngleAdjustable,
      createdAt: board.createdAt.toISOString(),
      layoutName: null,
      sizeName: null,
      sizeDescription: null,
      setNames: null,
      totalAscents: Number(ticks?.totalAscents || 0),
      uniqueClimbers: Number(ticks?.uniqueClimbers || 0),
      followerCount: followerMap.get(board.uuid) || 0,
      commentCount: commentMap.get(board.uuid) || 0,
      isFollowedByMe: followedSet.has(board.uuid),
      gymId: board.gymId ?? null,
      gymUuid: gym?.uuid ?? null,
      gymName: gym?.name ?? null,
      distanceMeters: distanceMeters ?? null,
      serialNumber: board.serialNumber ?? null,
    };
  });
}

// ============================================
// Popular Board Config Cache (Redis-backed)
// ============================================

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

const REDIS_CACHE_KEY = 'boardsesh:popular-board-configs';
const REDIS_CACHE_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year
const REDIS_LOCK_KEY = 'boardsesh:popular-board-configs:lock';
const REDIS_LOCK_TTL_SECONDS = 120; // 2 min lock to prevent duplicate queries across nodes

async function getPopularConfigs(): Promise<CachedPopularConfig[]> {
  // Try Redis cache first
  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      const cached = await publisher.get(REDIS_CACHE_KEY);
      if (cached) {
        return JSON.parse(cached) as CachedPopularConfig[];
      }
    } catch (err) {
      logger.error('[PopularConfigs] Redis read failed:', err);
    }
  }

  // Query all per-size configs with climb counts filtered by size edges AND set membership.
  // A climb counts for a config only if ALL its holds belong to placements in that config's sets.
  // board_climb_holds.hold_id = board_placements.id (placement ID).
  // ~31 configs, ~750ms worst case per LATERAL, cached in Redis for 1 year (refreshed on deploy).
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
        AND bc.edge_left > bps.edge_left
        AND bc.edge_right < bps.edge_right
        AND bc.edge_bottom > bps.edge_bottom
        AND bc.edge_top < bps.edge_top
        AND NOT EXISTS (
          SELECT 1 FROM board_climb_holds bch
          WHERE bch.climb_uuid = bc.uuid
            AND bch.board_type = bc.board_type
            AND NOT EXISTS (
              SELECT 1 FROM board_placements bp
              WHERE bp.board_type = bch.board_type
                AND bp.layout_id = bc.layout_id
                AND bp.id = bch.hold_id
                AND bp.set_id = ANY(configs.set_ids)
            )
        )
    ) cc ON true
    WHERE bl.is_listed = true
      AND bps.is_listed = true
    ORDER BY board_count DESC, total_ascents DESC, configs.board_type, bl.name
  `);

  const rows = rowsFromResult<Record<string, unknown>>(result);

  const configs: CachedPopularConfig[] = rows.map((row) => {
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

  // Store in Redis
  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      await publisher.set(REDIS_CACHE_KEY, JSON.stringify(configs), 'EX', REDIS_CACHE_TTL_SECONDS);
    } catch (err) {
      logger.error('[PopularConfigs] Redis write failed:', err);
    }
  }
  return configs;
}

/**
 * Refresh the popular configs Redis cache on server startup.
 * Always re-runs the query on deploy (data may have changed via Aurora sync).
 * Uses a Redis lock so only one node across the cluster runs the expensive query;
 * other nodes skip — they'll read from Redis when the resolver executes.
 */
export async function warmPopularConfigsCache(): Promise<void> {
  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();

      // Try to acquire lock — only the winning node runs the query
      const lockAcquired = await publisher.set(REDIS_LOCK_KEY, '1', 'EX', REDIS_LOCK_TTL_SECONDS, 'NX');
      if (!lockAcquired) {
        logger.info('[PopularConfigs] Another node is refreshing the cache, skipping');
        return;
      }
      // Winning node: delete stale cache so getPopularConfigs() runs the SQL query
      await publisher.del(REDIS_CACHE_KEY);
    } catch (err) {
      logger.error('[PopularConfigs] Redis lock failed:', err);
    }
  }

  logger.info('[PopularConfigs] Refreshing cache...');
  try {
    const configs = await getPopularConfigs();
    logger.info(`[PopularConfigs] Cache warmed with ${configs.length} configs`);
  } catch (err) {
    logger.error('[PopularConfigs] Cache warm-up failed:', err);
  }
}

// ============================================
// Queries
// ============================================

export const socialBoardQueries = {
  /**
   * Get a board by UUID
   */
  board: async (_: unknown, { boardUuid }: { boardUuid: string }, ctx: ConnectionContext) => {
    validateInput(UUIDSchema, boardUuid, 'boardUuid');

    const [board] = await db
      .select()
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.uuid, boardUuid), isNull(dbSchema.userBoards.deletedAt)))
      .limit(1);

    if (!board) return null;
    return enrichBoard(board, ctx.isAuthenticated ? ctx.userId : undefined);
  },

  /**
   * Get a board by slug (for URL routing)
   */
  boardBySlug: async (_: unknown, { slug }: { slug: string }, ctx: ConnectionContext) => {
    // Validate slug format: lowercase alphanumeric with hyphens, max 120 chars
    if (!slug || slug.length > 120 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
      return null;
    }

    const [board] = await db
      .select()
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.slug, slug), isNull(dbSchema.userBoards.deletedAt)))
      .limit(1);

    if (!board) return null;
    return enrichBoard(board, ctx.isAuthenticated ? ctx.userId : undefined);
  },

  /**
   * Look up boards by controller serial numbers.
   * Searches all boards (including unlisted/non-public) so BLE device
   * discovery can resolve any board regardless of visibility.
   * No auth required (BLE scan-before-login), but rate-limited.
   * Unauthenticated callers receive stripped responses (no GPS/owner data).
   */
  boardsBySerialNumbers: async (_: unknown, { serialNumbers }: { serialNumbers: string[] }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, 20, 'boardsBySerialNumbers');

    // Behaviour change: this used to silently `.slice(0, 20)` on overflow, now
    // it throws via Zod (`SerialNumberLookupSchema.max(20)`). Callers MUST cap
    // before sending — `resolveSerialNumbers` (the only first-party caller) does
    // this via `MAX_SERIALS_PER_REQUEST`. Throwing surfaces accidental breakage
    // in any future caller instead of silently dropping serials.
    const validated = validateInput(SerialNumberLookupSchema, { serialNumbers }, 'serialNumbers');
    const cleaned = validated.serialNumbers.filter((s) => s.length > 0);
    if (cleaned.length === 0) return [];

    const boards = await db
      .select()
      .from(dbSchema.userBoards)
      .where(and(inArray(dbSchema.userBoards.serialNumber, cleaned), isNull(dbSchema.userBoards.deletedAt)));

    // Unauthenticated callers get an allowlisted response built directly from
    // the DB rows — skip enrichBoards entirely (no owner/stats/follow queries).
    // Public boards include UGC fields; non-public boards get config only.
    if (!ctx.isAuthenticated) {
      return boards.map((board) => {
        return {
          id: Number(board.id),
          uuid: board.uuid,
          slug: board.slug,
          ownerId: '',
          ownerDisplayName: null,
          ownerAvatarUrl: null,
          boardType: board.boardType,
          layoutId: Number(board.layoutId),
          sizeId: Number(board.sizeId),
          setIds: board.setIds,
          name: board.isPublic ? board.name : board.boardType,
          description: board.isPublic ? board.description : null,
          locationName: board.isPublic ? board.locationName : null,
          latitude: null,
          longitude: null,
          isPublic: board.isPublic,
          isUnlisted: board.isUnlisted,
          hideLocation: board.hideLocation,
          isOwned: false,
          angle: Number(board.angle),
          isAngleAdjustable: board.isAngleAdjustable,
          createdAt: board.createdAt.toISOString(),
          layoutName: null,
          sizeName: null,
          sizeDescription: null,
          setNames: null,
          totalAscents: 0,
          uniqueClimbers: 0,
          followerCount: 0,
          commentCount: 0,
          isFollowedByMe: false,
          gymId: null,
          gymUuid: null,
          gymName: null,
          distanceMeters: null,
          serialNumber: board.serialNumber ?? null,
        };
      });
    }

    const enriched = await enrichBoards(
      boards.map((board) => ({ board })),
      ctx.userId,
    );

    return enriched;
  },

  /**
   * Auto-recorded serial→config rows for the current user, optionally joined
   * to the saved board they're linked to. Used as a fallback in serial lookups
   * and for detecting connect-time config mismatches.
   */
  myBoardSerialConfigs: async (_: unknown, { serialNumbers }: { serialNumbers: string[] }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'myBoardSerialConfigs');

    const validated = validateInput(SerialNumberLookupSchema, { serialNumbers }, 'serialNumbers');
    const cleaned = validated.serialNumbers.filter((s) => s.length > 0);
    if (cleaned.length === 0) return [];

    // requireAuthenticated only checks the isAuthenticated flag; explicitly
    // guard userId so a malformed context can't slip undefined into the query.
    const { userId } = ctx;
    if (!userId) {
      throw new Error('Authentication required to perform this operation');
    }

    const rows = await db
      .select({
        serialNumber: dbSchema.userBoardSerials.serialNumber,
        boardName: dbSchema.userBoardSerials.boardName,
        layoutId: dbSchema.userBoardSerials.layoutId,
        sizeId: dbSchema.userBoardSerials.sizeId,
        setIds: dbSchema.userBoardSerials.setIds,
        apiLevel: dbSchema.userBoardSerials.apiLevel,
        updatedAt: dbSchema.userBoardSerials.updatedAt,
        boardUuid: dbSchema.userBoardSerials.boardUuid,
        boardSlug: dbSchema.userBoards.slug,
      })
      .from(dbSchema.userBoardSerials)
      .leftJoin(
        dbSchema.userBoards,
        and(eq(dbSchema.userBoards.uuid, dbSchema.userBoardSerials.boardUuid), isNull(dbSchema.userBoards.deletedAt)),
      )
      .where(
        and(eq(dbSchema.userBoardSerials.userId, userId), inArray(dbSchema.userBoardSerials.serialNumber, cleaned)),
      );

    return rows.map((row) => ({
      serialNumber: row.serialNumber,
      boardName: row.boardName,
      layoutId: Number(row.layoutId),
      sizeId: Number(row.sizeId),
      setIds: row.setIds,
      apiLevel: row.apiLevel,
      updatedAt: row.updatedAt.toISOString(),
      boardUuid: row.boardUuid,
      boardSlug: row.boardSlug,
    }));
  },

  /**
   * Get current user's boards (owned + followed)
   */
  myBoards: async (_: unknown, { input }: { input?: { limit?: number; offset?: number } }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(MyBoardsInputSchema, input || {}, 'input');
    const userId = ctx.userId!;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // Get UUIDs of boards the user follows
    const followedBoardUuids = await db
      .select({ boardUuid: dbSchema.boardFollows.boardUuid })
      .from(dbSchema.boardFollows)
      .where(eq(dbSchema.boardFollows.userId, userId));

    const followedUuids = followedBoardUuids.map((f) => f.boardUuid);

    // Build WHERE: owned OR followed, and not deleted
    const ownerCondition = eq(dbSchema.userBoards.ownerId, userId);
    const followedCondition = followedUuids.length > 0 ? inArray(dbSchema.userBoards.uuid, followedUuids) : undefined;
    const matchCondition = followedCondition ? or(ownerCondition, followedCondition)! : ownerCondition;
    const whereClause = and(matchCondition, isNull(dbSchema.userBoards.deletedAt));

    const [countResult] = await db.select({ count: count() }).from(dbSchema.userBoards).where(whereClause);

    const totalCount = Number(countResult?.count || 0);

    const boards = await db
      .select()
      .from(dbSchema.userBoards)
      .where(whereClause)
      .orderBy(desc(dbSchema.userBoards.isOwned), desc(dbSchema.userBoards.createdAt))
      .limit(limit)
      .offset(offset);

    const enrichedBoards = await enrichBoards(
      boards.map((b) => ({ board: b })),
      userId,
    );

    return {
      boards: enrichedBoards,
      totalCount,
      hasMore: offset + boards.length < totalCount,
    };
  },

  /**
   * Search public boards
   */
  searchBoards: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, 20, 'searchBoards');
    const validatedInput = validateInput(SearchBoardsInputSchema, input, 'input');
    const { query, boardType, latitude, longitude, radiusKm } = validatedInput;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;
    const useProximity = latitude !== undefined && longitude !== undefined;

    if (useProximity) {
      // PostGIS proximity search path using Drizzle query builder
      const radiusMeters = (radiusKm ?? 1) * 1000;
      const lon = Number(longitude);
      const lat = Number(latitude);

      const userPoint = sql`ST_MakePoint(${lon}, ${lat})::geography`;
      // "location" is a PostGIS geography column added via raw migration, not in the Drizzle schema
      const locationCol = sql`${dbSchema.userBoards}.location`;
      const distanceMeters = sql<number>`ST_Distance(${locationCol}, ${userPoint})`.as('distance_meters');

      // Build shared WHERE conditions
      const conditions = [
        eq(dbSchema.userBoards.isPublic, true),
        eq(dbSchema.userBoards.isUnlisted, false),
        isNull(dbSchema.userBoards.deletedAt),
        sql`${locationCol} IS NOT NULL`,
        sql`ST_DWithin(${locationCol}, ${userPoint}, ${radiusMeters})`,
        // Hide boards with hideLocation=true unless the board owner follows the searching user
        sql`(${dbSchema.userBoards.hideLocation} = false${
          ctx.isAuthenticated
            ? sql` OR EXISTS (
                SELECT 1 FROM user_follows
                WHERE follower_id = ${dbSchema.userBoards.ownerId}
                AND following_id = ${ctx.userId}
              )`
            : sql``
        })`,
      ];

      if (boardType) {
        conditions.push(eq(dbSchema.userBoards.boardType, boardType));
      }
      if (query) {
        const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
        conditions.push(
          or(
            ilike(dbSchema.userBoards.name, `%${escapedQuery}%`),
            ilike(dbSchema.userBoards.locationName, `%${escapedQuery}%`),
          )!,
        );
      }

      const whereClause = and(...conditions);

      const [countResult] = await db.select({ count: count() }).from(dbSchema.userBoards).where(whereClause);

      const totalCount = Number(countResult?.count || 0);

      const boards = await db
        .select({
          board: dbSchema.userBoards,
          distanceMeters,
        })
        .from(dbSchema.userBoards)
        .where(whereClause)
        .orderBy(sql`distance_meters ASC`)
        .limit(limit)
        .offset(offset);

      const enrichedBoards = await enrichBoards(
        boards.map(({ board, distanceMeters: dist }) => ({ board, distanceMeters: dist })),
        ctx.isAuthenticated ? ctx.userId : undefined,
      );

      return {
        boards: enrichedBoards,
        totalCount,
        hasMore: offset + enrichedBoards.length < totalCount,
      };
    }

    // Text-only search path (no proximity)
    const conditions = [
      eq(dbSchema.userBoards.isPublic, true),
      eq(dbSchema.userBoards.isUnlisted, false),
      isNull(dbSchema.userBoards.deletedAt),
    ];

    if (boardType) {
      conditions.push(eq(dbSchema.userBoards.boardType, boardType));
    }

    if (query) {
      // Escape SQL LIKE wildcards to prevent wildcard injection
      const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
      conditions.push(
        or(
          ilike(dbSchema.userBoards.name, `%${escapedQuery}%`),
          ilike(dbSchema.userBoards.locationName, `%${escapedQuery}%`),
        )!,
      );
    }

    const whereClause = and(...conditions);

    const [countResult] = await db.select({ count: count() }).from(dbSchema.userBoards).where(whereClause);

    const totalCount = Number(countResult?.count || 0);

    const boards = await db
      .select()
      .from(dbSchema.userBoards)
      .where(whereClause)
      .orderBy(desc(dbSchema.userBoards.createdAt))
      .limit(limit)
      .offset(offset);

    const enrichedBoards = await enrichBoards(
      boards.map((b) => ({ board: b })),
      ctx.isAuthenticated ? ctx.userId : undefined,
    );

    return {
      boards: enrichedBoards,
      totalCount,
      hasMore: offset + boards.length < totalCount,
    };
  },

  /**
   * Get popular board configurations ranked by climb count
   */
  popularBoardConfigs: async (_: unknown, { input }: { input?: unknown }, _ctx: ConnectionContext) => {
    const validatedInput = validateInput(PopularBoardConfigsInputSchema, input || {}, 'input');
    const { boardType, limit, offset } = validatedInput;

    const allConfigs = await getPopularConfigs();

    // Apply optional board type filter
    const filtered = boardType ? allConfigs.filter((c) => c.boardType === boardType) : allConfigs;

    const totalCount = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

    return {
      configs: paginated,
      totalCount,
      hasMore: offset + paginated.length < totalCount,
    };
  },

  /**
   * Get leaderboard for a board
   */
  boardLeaderboard: async (_: unknown, { input }: { input: unknown }, _ctx: ConnectionContext) => {
    const validatedInput = validateInput(BoardLeaderboardInputSchema, input, 'input');
    const { boardUuid, period } = validatedInput;
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // Get the board
    const [board] = await db
      .select({ id: dbSchema.userBoards.id })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.uuid, boardUuid), isNull(dbSchema.userBoards.deletedAt)))
      .limit(1);

    if (!board) {
      throw new Error('Board not found');
    }

    // Build time filter
    let timeFilter;
    let periodLabel = 'All Time';
    if (period === 'week') {
      timeFilter = sql`${dbSchema.boardseshTicks.climbedAt} >= NOW() - INTERVAL '7 days'`;
      periodLabel = 'This Week';
    } else if (period === 'month') {
      timeFilter = sql`${dbSchema.boardseshTicks.climbedAt} >= NOW() - INTERVAL '30 days'`;
      periodLabel = 'This Month';
    } else if (period === 'year') {
      timeFilter = sql`${dbSchema.boardseshTicks.climbedAt} >= NOW() - INTERVAL '365 days'`;
      periodLabel = 'This Year';
    }

    const conditions = [
      eq(dbSchema.boardseshTicks.boardId, board.id),
      or(eq(dbSchema.boardseshTicks.status, 'flash'), eq(dbSchema.boardseshTicks.status, 'send'))!,
    ];

    if (timeFilter) {
      conditions.push(timeFilter);
    }

    const whereClause = and(...conditions);

    // Get total distinct users
    const [countResult] = await db
      .select({ count: sql<number>`COUNT(DISTINCT ${dbSchema.boardseshTicks.userId})` })
      .from(dbSchema.boardseshTicks)
      .where(whereClause);

    const totalCount = Number(countResult?.count || 0);

    // Get leaderboard entries. `hardestGrade` falls back to the climb's
    // consensus grade when the user didn't attach a personal override (NULL
    // difficulty means "use consensus" — see docs/ascents-and-attempts.md).
    // board_climb_stats joined on its PK so the join doesn't multiply rows.
    const entries = await db
      .select({
        userId: dbSchema.boardseshTicks.userId,
        totalSends: count(),
        totalFlashes: sql<number>`SUM(CASE WHEN ${dbSchema.boardseshTicks.status} = 'flash' THEN 1 ELSE 0 END)`,
        hardestGrade: sql<
          number | null
        >`MAX(COALESCE(${dbSchema.boardseshTicks.difficulty}, ${consensusDifficultyExpr}))`,
        totalSessions: sql<number>`COUNT(DISTINCT DATE(${dbSchema.boardseshTicks.climbedAt}))`,
      })
      .from(dbSchema.boardseshTicks)
      .leftJoin(
        dbSchema.boardClimbStats,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbStats.climbUuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbStats.boardType),
          eq(dbSchema.boardseshTicks.angle, dbSchema.boardClimbStats.angle),
        ),
      )
      .where(whereClause)
      .groupBy(dbSchema.boardseshTicks.userId)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(limit)
      .offset(offset);

    // Batch fetch user profiles
    const userIds = entries.map((e) => e.userId);
    const userMap = new Map<string, { displayName?: string; avatarUrl?: string }>();

    if (userIds.length > 0) {
      const users = await db
        .select({
          id: dbSchema.users.id,
          name: dbSchema.users.name,
          image: dbSchema.users.image,
          displayName: dbSchema.userProfiles.displayName,
          avatarUrl: dbSchema.userProfiles.avatarUrl,
        })
        .from(dbSchema.users)
        .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
        .where(inArray(dbSchema.users.id, userIds));

      for (const u of users) {
        userMap.set(u.id, {
          displayName: u.displayName || u.name || undefined,
          avatarUrl: u.avatarUrl || u.image || undefined,
        });
      }
    }

    const enrichedEntries = entries.map((entry, idx) => {
      const userInfo = userMap.get(entry.userId);
      return {
        userId: entry.userId,
        userDisplayName: userInfo?.displayName,
        userAvatarUrl: userInfo?.avatarUrl,
        rank: offset + idx + 1,
        totalSends: Number(entry.totalSends),
        totalFlashes: Number(entry.totalFlashes),
        hardestGrade: entry.hardestGrade ? Number(entry.hardestGrade) : null,
        hardestGradeName: null, // TODO: resolve grade name from board-specific grade tables
        totalSessions: Number(entry.totalSessions),
      };
    });

    return {
      boardUuid,
      entries: enrichedEntries,
      totalCount,
      hasMore: offset + entries.length < totalCount,
      periodLabel,
    };
  },

  /**
   * Get the user's default board
   */
  defaultBoard: async (_: unknown, _args: unknown, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    // First: try to find an owned board
    const [ownedBoard] = await db
      .select()
      .from(dbSchema.userBoards)
      .where(
        and(
          eq(dbSchema.userBoards.ownerId, userId),
          eq(dbSchema.userBoards.isOwned, true),
          isNull(dbSchema.userBoards.deletedAt),
        ),
      )
      .orderBy(desc(dbSchema.userBoards.createdAt))
      .limit(1);

    if (ownedBoard) {
      return enrichBoard(ownedBoard, userId);
    }

    // Fallback: any board owned by user
    const [anyBoard] = await db
      .select()
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.ownerId, userId), isNull(dbSchema.userBoards.deletedAt)))
      .orderBy(desc(dbSchema.userBoards.createdAt))
      .limit(1);

    if (anyBoard) {
      return enrichBoard(anyBoard, userId);
    }

    return null;
  },
};

// ============================================
// Mutations
// ============================================

export const socialBoardMutations = {
  /**
   * Record the (serial, board config) the current user was on when connecting
   * to a controller over BLE. Replaces the deleted REST route
   * POST /api/internal/board-serials. Upserts into userBoardSerials keyed by
   * (userId, serialNumber), capturing the API level advertised after the `@` in
   * the device name. Returns the stored recording, or null when the user already
   * has a saved board whose config matches the connect (nothing to record).
   */
  recordBoardSerial: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    // Dedicated `recordBoardSerial` namespace so this 30/min budget is isolated
    // from the shared 'default' bucket. requireAuthenticated already rejects
    // anonymous callers before any DB work, so an unauthenticated flood never
    // reaches here — the per-user limit (in-memory + Redis, keyed on the
    // validated token's userId) replaces the deleted REST route's IP guard,
    // which only existed to throttle that pre-auth path.
    await applyRateLimit(ctx, 30, 'recordBoardSerial');

    const validatedInput = validateInput(RecordBoardSerialInputSchema, input, 'input');
    const userId = ctx.userId!;
    const { serialNumber, boardName, layoutId, sizeId, setIds, apiLevel, boardUuid } = validatedInput;

    // If the user already has a saved board for this controller AND its config
    // matches, the recording adds nothing — skip the write and return null. The
    // saved board stays authoritative for serial→board lookups; recordings only
    // exist to provide a fallback and to detect drift when the configs differ.
    const [savedMatch] = await db
      .select({
        boardType: dbSchema.userBoards.boardType,
        layoutId: dbSchema.userBoards.layoutId,
        sizeId: dbSchema.userBoards.sizeId,
        setIds: dbSchema.userBoards.setIds,
      })
      .from(dbSchema.userBoards)
      .where(
        and(
          eq(dbSchema.userBoards.ownerId, userId),
          eq(dbSchema.userBoards.serialNumber, serialNumber),
          isNull(dbSchema.userBoards.deletedAt),
        ),
      )
      .limit(1);

    if (
      savedMatch &&
      savedMatch.boardType === boardName &&
      Number(savedMatch.layoutId) === layoutId &&
      Number(savedMatch.sizeId) === sizeId &&
      normaliseSetIds(savedMatch.setIds) === normaliseSetIds(setIds)
    ) {
      return null;
    }

    // Validate boardUuid before linking: only persist the link if the user can
    // legitimately reach the board (owner or public). A forged/unauthorised uuid
    // is silently dropped to null so it can't attach the controller to someone
    // else's private board.
    let linkedBoardUuid: string | null = null;
    if (boardUuid) {
      const [allowed] = await db
        .select({ uuid: dbSchema.userBoards.uuid })
        .from(dbSchema.userBoards)
        .where(
          and(
            eq(dbSchema.userBoards.uuid, boardUuid),
            isNull(dbSchema.userBoards.deletedAt),
            or(eq(dbSchema.userBoards.ownerId, userId), eq(dbSchema.userBoards.isPublic, true)),
          ),
        )
        .limit(1);
      if (allowed) {
        linkedBoardUuid = boardUuid;
      }
    }

    // Coalesce to an explicit null rather than letting `undefined` fall through.
    // On the insert path the two are equivalent, but in the onConflictDoUpdate
    // `set` below Drizzle omits `undefined` columns from the UPDATE — which would
    // preserve a stale api_level from a previous connect instead of recording
    // what *this* connect observed. The explicit null keeps the row honest.
    const apiLevelValue = apiLevel ?? null;

    await db
      .insert(dbSchema.userBoardSerials)
      .values({
        userId,
        serialNumber,
        boardName,
        layoutId,
        sizeId,
        setIds,
        apiLevel: apiLevelValue,
        boardUuid: linkedBoardUuid,
      })
      .onConflictDoUpdate({
        target: [dbSchema.userBoardSerials.userId, dbSchema.userBoardSerials.serialNumber],
        set: {
          boardName,
          layoutId,
          sizeId,
          setIds,
          apiLevel: apiLevelValue,
          boardUuid: linkedBoardUuid,
          updatedAt: new Date(),
        },
      });

    const [row] = await db
      .select({
        serialNumber: dbSchema.userBoardSerials.serialNumber,
        boardName: dbSchema.userBoardSerials.boardName,
        layoutId: dbSchema.userBoardSerials.layoutId,
        sizeId: dbSchema.userBoardSerials.sizeId,
        setIds: dbSchema.userBoardSerials.setIds,
        apiLevel: dbSchema.userBoardSerials.apiLevel,
        updatedAt: dbSchema.userBoardSerials.updatedAt,
        boardUuid: dbSchema.userBoardSerials.boardUuid,
        boardSlug: dbSchema.userBoards.slug,
      })
      .from(dbSchema.userBoardSerials)
      .leftJoin(
        dbSchema.userBoards,
        and(eq(dbSchema.userBoards.uuid, dbSchema.userBoardSerials.boardUuid), isNull(dbSchema.userBoards.deletedAt)),
      )
      .where(
        and(eq(dbSchema.userBoardSerials.userId, userId), eq(dbSchema.userBoardSerials.serialNumber, serialNumber)),
      )
      .limit(1);

    // The upsert above always writes a row, so the re-select can only come back
    // empty under a concurrent delete of this exact (userId, serialNumber). Guard
    // it so that race surfaces as a clean GraphQL error instead of an untyped
    // "cannot read property of undefined" crash.
    if (!row) {
      throw new Error('Failed to record board serial');
    }

    return {
      serialNumber: row.serialNumber,
      boardName: row.boardName,
      layoutId: Number(row.layoutId),
      sizeId: Number(row.sizeId),
      setIds: row.setIds,
      apiLevel: row.apiLevel,
      updatedAt: row.updatedAt.toISOString(),
      boardUuid: row.boardUuid,
      boardSlug: row.boardSlug,
    };
  },

  /**
   * Create a new board
   */
  createBoard: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'createBoard');

    const validatedInput = validateInput(CreateBoardInputSchema, input, 'input');
    const userId = ctx.userId!;

    // Check for duplicate config
    const [existing] = await db
      .select({ id: dbSchema.userBoards.id })
      .from(dbSchema.userBoards)
      .where(
        and(
          eq(dbSchema.userBoards.ownerId, userId),
          eq(dbSchema.userBoards.boardType, validatedInput.boardType),
          eq(dbSchema.userBoards.layoutId, validatedInput.layoutId),
          eq(dbSchema.userBoards.sizeId, validatedInput.sizeId),
          eq(dbSchema.userBoards.setIds, validatedInput.setIds),
          isNull(dbSchema.userBoards.deletedAt),
        ),
      )
      .limit(1);

    if (existing) {
      throw new Error('You already have a board with this configuration');
    }

    const uuid = uuidv4();
    const slug = await generateUniqueSlug(validatedInput.name);

    // Resolve gymId from gymUuid if provided
    let gymId: number | null = null;
    if (validatedInput.gymUuid) {
      const [gym] = await db
        .select({ id: dbSchema.gyms.id, ownerId: dbSchema.gyms.ownerId })
        .from(dbSchema.gyms)
        .where(and(eq(dbSchema.gyms.uuid, validatedInput.gymUuid), isNull(dbSchema.gyms.deletedAt)))
        .limit(1);

      if (!gym) {
        throw new Error('Gym not found');
      }

      // Verify user is owner or admin of the gym
      if (gym.ownerId !== userId) {
        const [member] = await db
          .select({ role: dbSchema.gymMembers.role })
          .from(dbSchema.gymMembers)
          .where(
            and(
              eq(dbSchema.gymMembers.gymId, gym.id),
              eq(dbSchema.gymMembers.userId, userId),
              eq(dbSchema.gymMembers.role, 'admin'),
            ),
          )
          .limit(1);

        if (!member) {
          throw new Error('Not authorized to link board to this gym');
        }
      }

      gymId = gym.id;
    } else {
      // Auto-create a gym if user has zero gyms
      const [existingGym] = await db
        .select({ id: dbSchema.gyms.id })
        .from(dbSchema.gyms)
        .where(and(eq(dbSchema.gyms.ownerId, userId), isNull(dbSchema.gyms.deletedAt)))
        .limit(1);

      if (!existingGym) {
        // Auto-create a gym for the user. If this fails, fall through
        // and create the board without a gym link rather than failing entirely.
        try {
          const gymName = validatedInput.locationName || validatedInput.name;
          const gymUuid = uuidv4();
          const gymSlug = await generateUniqueGymSlug(gymName);

          // Use transaction to atomically create gym + board
          const board = await db.transaction(async (tx) => {
            const [newGym] = await tx
              .insert(dbSchema.gyms)
              .values({
                uuid: gymUuid,
                slug: gymSlug,
                ownerId: userId,
                name: gymName,
                isPublic: validatedInput.isPublic ?? true,
                latitude: validatedInput.latitude ?? null,
                longitude: validatedInput.longitude ?? null,
              })
              .returning();

            if (validatedInput.latitude != null && validatedInput.longitude != null) {
              await tx.execute(
                sql`UPDATE gyms SET location = ST_MakePoint(${validatedInput.longitude}, ${validatedInput.latitude})::geography WHERE id = ${newGym.id}`,
              );
            }

            const [newBoard] = await tx
              .insert(dbSchema.userBoards)
              .values({
                uuid,
                slug,
                ownerId: userId,
                boardType: validatedInput.boardType,
                layoutId: validatedInput.layoutId,
                sizeId: validatedInput.sizeId,
                setIds: validatedInput.setIds,
                name: validatedInput.name,
                description: validatedInput.description ?? null,
                locationName: validatedInput.locationName ?? null,
                latitude: validatedInput.latitude ?? null,
                longitude: validatedInput.longitude ?? null,
                isPublic: validatedInput.isPublic ?? true,
                isUnlisted: validatedInput.isUnlisted ?? false,
                hideLocation: validatedInput.hideLocation ?? false,
                isOwned: validatedInput.isOwned ?? true,
                angle: validatedInput.angle ?? 40,
                isAngleAdjustable: validatedInput.isAngleAdjustable ?? true,
                serialNumber: validatedInput.serialNumber ?? null,
                gymId: newGym.id,
              })
              .returning();

            if (validatedInput.latitude != null && validatedInput.longitude != null) {
              await tx.execute(
                sql`UPDATE user_boards SET location = ST_MakePoint(${validatedInput.longitude}, ${validatedInput.latitude})::geography WHERE id = ${newBoard.id}`,
              );
            }

            return newBoard;
          });

          return await enrichBoard(board, userId);
        } catch (error) {
          throwIfBoardSerialConflict(error);
          // Auto-gym creation failed; continue to create the board without a gym
          logger.error('Auto-gym creation failed, creating board without gym:', error);
        }
      }
    }

    let board: typeof dbSchema.userBoards.$inferSelect;
    try {
      [board] = await db
        .insert(dbSchema.userBoards)
        .values({
          uuid,
          slug,
          ownerId: userId,
          boardType: validatedInput.boardType,
          layoutId: validatedInput.layoutId,
          sizeId: validatedInput.sizeId,
          setIds: validatedInput.setIds,
          name: validatedInput.name,
          description: validatedInput.description ?? null,
          locationName: validatedInput.locationName ?? null,
          latitude: validatedInput.latitude ?? null,
          longitude: validatedInput.longitude ?? null,
          isPublic: validatedInput.isPublic ?? true,
          isUnlisted: validatedInput.isUnlisted ?? false,
          hideLocation: validatedInput.hideLocation ?? false,
          isOwned: validatedInput.isOwned ?? true,
          angle: validatedInput.angle ?? 40,
          isAngleAdjustable: validatedInput.isAngleAdjustable ?? true,
          serialNumber: validatedInput.serialNumber ?? null,
          gymId,
        })
        .returning();
    } catch (error) {
      throwIfBoardSerialConflict(error);
      throw error;
    }

    // Populate PostGIS location column if lat/lon provided
    if (validatedInput.latitude != null && validatedInput.longitude != null) {
      await db.execute(
        sql`UPDATE user_boards SET location = ST_MakePoint(${validatedInput.longitude}, ${validatedInput.latitude})::geography WHERE id = ${board.id}`,
      );
    }

    return enrichBoard(board, userId);
  },

  /**
   * Update a board's metadata
   */
  updateBoard: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'updateBoard');

    const validatedInput = validateInput(UpdateBoardInputSchema, input, 'input');
    const userId = ctx.userId!;

    // Verify ownership
    const [board] = await db
      .select()
      .from(dbSchema.userBoards)
      .where(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid))
      .limit(1);

    if (!board) {
      throw new Error('Board not found');
    }

    if (board.ownerId !== userId) {
      throw new Error('Not authorized to update this board');
    }

    // Build update values (only provided fields)
    const updateValues: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (validatedInput.name !== undefined) updateValues.name = validatedInput.name;
    if (validatedInput.description !== undefined) updateValues.description = validatedInput.description;
    if (validatedInput.locationName !== undefined) updateValues.locationName = validatedInput.locationName;
    if (validatedInput.latitude !== undefined) updateValues.latitude = validatedInput.latitude;
    if (validatedInput.longitude !== undefined) updateValues.longitude = validatedInput.longitude;
    if (validatedInput.isPublic !== undefined) updateValues.isPublic = validatedInput.isPublic;
    if (validatedInput.isUnlisted !== undefined) updateValues.isUnlisted = validatedInput.isUnlisted;
    if (validatedInput.hideLocation !== undefined) updateValues.hideLocation = validatedInput.hideLocation;
    if (validatedInput.isOwned !== undefined) updateValues.isOwned = validatedInput.isOwned;
    if (validatedInput.angle !== undefined) updateValues.angle = validatedInput.angle;
    if (validatedInput.isAngleAdjustable !== undefined)
      updateValues.isAngleAdjustable = validatedInput.isAngleAdjustable;
    if (validatedInput.serialNumber !== undefined) updateValues.serialNumber = validatedInput.serialNumber;

    // Handle config field changes (layoutId, sizeId, setIds) — only allowed on boards with zero ticks
    const hasConfigChange =
      validatedInput.layoutId !== undefined ||
      validatedInput.sizeId !== undefined ||
      validatedInput.setIds !== undefined;

    if (hasConfigChange) {
      const [tickCount] = await db
        .select({ total: count() })
        .from(dbSchema.boardseshTicks)
        .where(eq(dbSchema.boardseshTicks.boardId, board.id));

      if (Number(tickCount?.total || 0) > 0) {
        throw new Error(
          'Cannot change board configuration because this board has logged climbs. Delete the board and create a new one instead.',
        );
      }

      // Check unique constraint: no other active board with same config for this user
      const newLayoutId = validatedInput.layoutId ?? board.layoutId;
      const newSizeId = validatedInput.sizeId ?? board.sizeId;
      const newSetIds = validatedInput.setIds ?? board.setIds;

      const [configConflict] = await db
        .select({ id: dbSchema.userBoards.id })
        .from(dbSchema.userBoards)
        .where(
          and(
            eq(dbSchema.userBoards.ownerId, userId),
            eq(dbSchema.userBoards.boardType, board.boardType),
            eq(dbSchema.userBoards.layoutId, newLayoutId),
            eq(dbSchema.userBoards.sizeId, newSizeId),
            eq(dbSchema.userBoards.setIds, newSetIds),
            isNull(dbSchema.userBoards.deletedAt),
            sql`${dbSchema.userBoards.id} != ${board.id}`,
          ),
        )
        .limit(1);

      if (configConflict) {
        throw new Error('You already have a board with this configuration');
      }

      if (validatedInput.layoutId !== undefined) updateValues.layoutId = validatedInput.layoutId;
      if (validatedInput.sizeId !== undefined) updateValues.sizeId = validatedInput.sizeId;
      if (validatedInput.setIds !== undefined) updateValues.setIds = validatedInput.setIds;
    }

    // Handle slug update
    if (validatedInput.slug !== undefined) {
      // Check slug uniqueness
      const [slugConflict] = await db
        .select({ id: dbSchema.userBoards.id })
        .from(dbSchema.userBoards)
        .where(
          and(
            eq(dbSchema.userBoards.slug, validatedInput.slug),
            isNull(dbSchema.userBoards.deletedAt),
            sql`${dbSchema.userBoards.id} != ${board.id}`,
          ),
        )
        .limit(1);

      if (slugConflict) {
        throw new Error('Slug is already taken');
      }
      updateValues.slug = validatedInput.slug;
    }

    // If board was soft-deleted, restore it
    if (board.deletedAt) {
      updateValues.deletedAt = null;
    }

    let updated: typeof dbSchema.userBoards.$inferSelect;
    try {
      [updated] = await db
        .update(dbSchema.userBoards)
        .set(updateValues)
        .where(eq(dbSchema.userBoards.id, board.id))
        .returning();
    } catch (error) {
      throwIfBoardSerialConflict(error);
      throw error;
    }

    // Update PostGIS location column
    if (validatedInput.latitude !== undefined || validatedInput.longitude !== undefined) {
      const lat = validatedInput.latitude ?? updated.latitude;
      const lon = validatedInput.longitude ?? updated.longitude;
      if (lat != null && lon != null) {
        await db.execute(
          sql`UPDATE user_boards SET location = ST_MakePoint(${lon}, ${lat})::geography WHERE id = ${updated.id}`,
        );
      } else {
        await db.execute(sql`UPDATE user_boards SET location = NULL WHERE id = ${updated.id}`);
      }
    }

    return enrichBoard(updated, userId);
  },

  /**
   * Soft-delete a board
   */
  deleteBoard: async (_: unknown, { boardUuid }: { boardUuid: string }, ctx: ConnectionContext): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'deleteBoard');

    validateInput(UUIDSchema, boardUuid, 'boardUuid');
    const userId = ctx.userId!;

    const [board] = await db
      .select({ id: dbSchema.userBoards.id, ownerId: dbSchema.userBoards.ownerId })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.uuid, boardUuid), isNull(dbSchema.userBoards.deletedAt)))
      .limit(1);

    if (!board) {
      throw new Error('Board not found');
    }

    if (board.ownerId !== userId) {
      throw new Error('Not authorized to delete this board');
    }

    await db.update(dbSchema.userBoards).set({ deletedAt: new Date() }).where(eq(dbSchema.userBoards.id, board.id));

    return true;
  },

  /**
   * Follow a board
   */
  followBoard: async (
    _: unknown,
    { input }: { input: { boardUuid: string } },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'followBoard');

    const validatedInput = validateInput(FollowBoardInputSchema, input, 'input');
    const userId = ctx.userId!;

    // Verify board exists and is accessible
    const [board] = await db
      .select({
        uuid: dbSchema.userBoards.uuid,
        ownerId: dbSchema.userBoards.ownerId,
        isPublic: dbSchema.userBoards.isPublic,
      })
      .from(dbSchema.userBoards)
      .where(and(eq(dbSchema.userBoards.uuid, validatedInput.boardUuid), isNull(dbSchema.userBoards.deletedAt)))
      .limit(1);

    if (!board) {
      throw new Error('Board not found');
    }

    if (!board.isPublic && board.ownerId !== userId) {
      throw new Error('Cannot follow a private board');
    }

    await db
      .insert(dbSchema.boardFollows)
      .values({
        userId,
        boardUuid: validatedInput.boardUuid,
      })
      .onConflictDoNothing();

    return true;
  },

  /**
   * Unfollow a board
   */
  unfollowBoard: async (
    _: unknown,
    { input }: { input: { boardUuid: string } },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'unfollowBoard');

    const validatedInput = validateInput(FollowBoardInputSchema, input, 'input');
    const userId = ctx.userId!;

    await db
      .delete(dbSchema.boardFollows)
      .where(
        and(eq(dbSchema.boardFollows.userId, userId), eq(dbSchema.boardFollows.boardUuid, validatedInput.boardUuid)),
      );

    return true;
  },
};
