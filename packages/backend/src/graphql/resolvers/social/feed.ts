import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import {
  difficultyNameWithFallbackExpr,
  consensusGradeTable,
  consensusGradeJoinCondition,
  tickCommentCountExpr,
} from '../shared/sql-expressions';
import { FollowingAscentsFeedInputSchema, FollowingClimbAscentsInputSchema } from '../../../validation/schemas';
import { logger } from '../../../utils/logger';

export const socialFeedQueries = {
  /**
   * Get activity feed of ascents from followed users
   * Requires authentication (personalized feed)
   */
  followingAscentsFeed: async (
    _: unknown,
    { input }: { input?: { limit?: number; offset?: number } },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);
    const myUserId = ctx.userId!;

    const validatedInput = validateInput(FollowingAscentsFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // Get the list of users I follow
    const followedUsers = await db
      .select({ followingId: dbSchema.userFollows.followingId })
      .from(dbSchema.userFollows)
      .where(eq(dbSchema.userFollows.followerId, myUserId));

    const followedUserIds = followedUsers.map((f) => f.followingId);

    if (followedUserIds.length === 0) {
      return {
        items: [],
        totalCount: 0,
        hasMore: false,
      };
    }

    // Fetch ticks with user, climb, and grade data
    const results = await db
      .select({
        tick: dbSchema.boardseshTicks,
        userName: dbSchema.users.name,
        userImage: dbSchema.users.image,
        userDisplayName: dbSchema.userProfiles.displayName,
        userAvatarUrl: dbSchema.userProfiles.avatarUrl,
        climbName: dbSchema.boardClimbs.name,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        difficultyName: difficultyNameWithFallbackExpr,
      })
      .from(dbSchema.boardseshTicks)
      .innerJoin(dbSchema.users, eq(dbSchema.boardseshTicks.userId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.boardseshTicks.userId, dbSchema.userProfiles.userId))
      // Resolve dedup-merged climbs to their canonical UUID before joining
      // board_climbs / board_climb_stats. A tick may point at an alias UUID that
      // was deduplicated away (no board_climbs row); the alias table maps it to
      // the canonical. Ticks already on a canonical have a self-alias or no alias
      // row, so COALESCE falls back to the tick's own climb_uuid.
      .leftJoin(
        dbSchema.boardClimbAliases,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbAliases.aliasUuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbAliases.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          sql`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid}) = ${dbSchema.boardClimbs.uuid}`,
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbs.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardseshTicks.difficulty, dbSchema.boardDifficultyGrades.difficulty),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardDifficultyGrades.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardClimbStats,
        and(
          sql`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid}) = ${dbSchema.boardClimbStats.climbUuid}`,
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbStats.boardType),
          eq(dbSchema.boardseshTicks.angle, dbSchema.boardClimbStats.angle),
        ),
      )
      .leftJoin(consensusGradeTable, consensusGradeJoinCondition)
      .where(
        and(
          inArray(dbSchema.boardseshTicks.userId, followedUserIds),
          // A community-hidden climb drops out of the feed along with every tick
          // logged on it — the feed is a browse surface. `IS NOT TRUE` rather
          // than `= false` because `board_climbs` is LEFT JOINed here: a tick
          // whose climb row is missing still renders as "Unknown Climb", and
          // `is_hidden = false` would silently drop those too.
          sql`${dbSchema.boardClimbs.isHidden} IS NOT TRUE`,
        ),
      )
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = results.length > limit;
    const resultRows = hasMore ? results.slice(0, limit) : results;

    const items = resultRows.map(
      ({
        tick,
        userName,
        userImage,
        userDisplayName,
        userAvatarUrl,
        climbName,
        setterUsername,
        layoutId,
        frames,
        difficultyName,
      }) => ({
        uuid: tick.uuid,
        userId: tick.userId,
        userDisplayName: userDisplayName || userName || undefined,
        userAvatarUrl: userAvatarUrl || userImage || undefined,
        climbUuid: tick.climbUuid,
        climbName: climbName || 'Unknown Climb',
        setterUsername,
        boardType: tick.boardType,
        layoutId,
        angle: tick.angle,
        isMirror: tick.isMirror ?? false,
        status: tick.status,
        attemptCount: tick.attemptCount,
        quality: tick.quality,
        difficulty: tick.difficulty,
        difficultyName,
        isBenchmark: tick.isBenchmark ?? false,
        comment: tick.comment || '',
        climbedAt: tick.climbedAt,
        frames,
      }),
    );

    return {
      items,
      totalCount: 0, // Intentionally 0 — full COUNT(*) was too expensive. No frontend uses this value.
      hasMore,
    };
  },

  /**
   * Get global activity feed of all recent ascents
   * No authentication required
   */
  globalAscentsFeed: async (_: unknown, { input }: { input?: { limit?: number; offset?: number } }) => {
    const validatedInput = validateInput(FollowingAscentsFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // Fetch ticks with user, climb, and grade data
    const results = await db
      .select({
        tick: dbSchema.boardseshTicks,
        userName: dbSchema.users.name,
        userImage: dbSchema.users.image,
        userDisplayName: dbSchema.userProfiles.displayName,
        userAvatarUrl: dbSchema.userProfiles.avatarUrl,
        climbName: dbSchema.boardClimbs.name,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        difficultyName: difficultyNameWithFallbackExpr,
      })
      .from(dbSchema.boardseshTicks)
      .innerJoin(dbSchema.users, eq(dbSchema.boardseshTicks.userId, dbSchema.users.id))
      .leftJoin(dbSchema.userProfiles, eq(dbSchema.boardseshTicks.userId, dbSchema.userProfiles.userId))
      // Resolve dedup-merged climbs to their canonical UUID before joining
      // board_climbs / board_climb_stats. See followingAscentsFeed for rationale.
      .leftJoin(
        dbSchema.boardClimbAliases,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbAliases.aliasUuid),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbAliases.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          sql`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid}) = ${dbSchema.boardClimbs.uuid}`,
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbs.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardseshTicks.difficulty, dbSchema.boardDifficultyGrades.difficulty),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardDifficultyGrades.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardClimbStats,
        and(
          sql`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid}) = ${dbSchema.boardClimbStats.climbUuid}`,
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbStats.boardType),
          eq(dbSchema.boardseshTicks.angle, dbSchema.boardClimbStats.angle),
        ),
      )
      .leftJoin(consensusGradeTable, consensusGradeJoinCondition)
      // Same hidden-climb rule as `followingAscentsFeed` — see the note there
      // for why this is `IS NOT TRUE` against a LEFT JOIN.
      .where(sql`${dbSchema.boardClimbs.isHidden} IS NOT TRUE`)
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = results.length > limit;
    const resultRows = hasMore ? results.slice(0, limit) : results;

    const items = resultRows.map(
      ({
        tick,
        userName,
        userImage,
        userDisplayName,
        userAvatarUrl,
        climbName,
        setterUsername,
        layoutId,
        frames,
        difficultyName,
      }) => ({
        uuid: tick.uuid,
        userId: tick.userId,
        userDisplayName: userDisplayName || userName || undefined,
        userAvatarUrl: userAvatarUrl || userImage || undefined,
        climbUuid: tick.climbUuid,
        climbName: climbName || 'Unknown Climb',
        setterUsername,
        boardType: tick.boardType,
        layoutId,
        angle: tick.angle,
        isMirror: tick.isMirror ?? false,
        status: tick.status,
        attemptCount: tick.attemptCount,
        quality: tick.quality,
        difficulty: tick.difficulty,
        difficultyName,
        isBenchmark: tick.isBenchmark ?? false,
        comment: tick.comment || '',
        climbedAt: tick.climbedAt,
        frames,
      }),
    );

    return {
      items,
      totalCount: 0, // Intentionally 0 — full COUNT(*) was too expensive. No frontend uses this value.
      hasMore,
    };
  },

  /**
   * Get ticks from followed users for a specific climb
   * Requires authentication
   */
  followingClimbAscents: async (
    _: unknown,
    { input }: { input: { boardType: string; climbUuid: string } },
    ctx: ConnectionContext,
  ) => {
    requireAuthenticated(ctx);
    const myUserId = ctx.userId!;

    const validatedInput = validateInput(FollowingClimbAscentsInputSchema, input, 'input');

    // Cap results to avoid runaway payloads on highly-trafficked climbs.
    // The UI is a collapsed list — 100 recent ticks is plenty.
    const MAX_ITEMS = 100;

    try {
      const results = await db
        .select({
          tick: dbSchema.boardseshTicks,
          userName: dbSchema.users.name,
          userImage: dbSchema.users.image,
          userDisplayName: dbSchema.userProfiles.displayName,
          userAvatarUrl: dbSchema.userProfiles.avatarUrl,
          upvotes: dbSchema.voteCounts.upvotes,
          downvotes: dbSchema.voteCounts.downvotes,
          commentCount: tickCommentCountExpr,
        })
        .from(dbSchema.boardseshTicks)
        .innerJoin(
          dbSchema.userFollows,
          and(
            eq(dbSchema.userFollows.followingId, dbSchema.boardseshTicks.userId),
            eq(dbSchema.userFollows.followerId, myUserId),
          ),
        )
        .innerJoin(dbSchema.users, eq(dbSchema.boardseshTicks.userId, dbSchema.users.id))
        .leftJoin(dbSchema.userProfiles, eq(dbSchema.boardseshTicks.userId, dbSchema.userProfiles.userId))
        .leftJoin(
          dbSchema.voteCounts,
          and(
            eq(dbSchema.voteCounts.entityType, 'tick'),
            eq(dbSchema.voteCounts.entityId, dbSchema.boardseshTicks.uuid),
          ),
        )
        .where(
          and(
            eq(dbSchema.boardseshTicks.boardType, validatedInput.boardType),
            eq(dbSchema.boardseshTicks.climbUuid, validatedInput.climbUuid),
          ),
        )
        .orderBy(desc(dbSchema.boardseshTicks.climbedAt))
        .limit(MAX_ITEMS);

      const items = results.map(
        ({ tick, userName, userImage, userDisplayName, userAvatarUrl, upvotes, downvotes, commentCount }) => ({
          uuid: tick.uuid,
          userId: tick.userId,
          userDisplayName: userDisplayName || userName || undefined,
          userAvatarUrl: userAvatarUrl || userImage || undefined,
          climbUuid: tick.climbUuid,
          boardType: tick.boardType,
          angle: tick.angle,
          isMirror: tick.isMirror ?? false,
          status: tick.status,
          attemptCount: tick.attemptCount,
          quality: tick.quality,
          difficulty: tick.difficulty,
          isBenchmark: tick.isBenchmark ?? false,
          comment: tick.comment || '',
          climbedAt: tick.climbedAt,
          upvotes: Number(upvotes ?? 0),
          downvotes: Number(downvotes ?? 0),
          commentCount: Number(commentCount ?? 0),
        }),
      );

      return { items };
    } catch (err) {
      logger.error('[followingClimbAscents] DB error:', err);
      throw err;
    }
  },
};
