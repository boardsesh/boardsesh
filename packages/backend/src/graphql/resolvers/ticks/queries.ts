import { eq, ne, and, or, desc, inArray, isNull, sql, count, ilike, gte, lte } from 'drizzle-orm';
import {
  type ConnectionContext,
  type BoardName,
  SUPPORTED_BOARDS,
  matchClimbsToCaption,
  extractQuotedClimbNames,
} from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, applyRateLimit, validateInput, isNoMatchClimb } from '../shared/helpers';
import {
  consensusDifficultyNameExpr,
  consensusDifficultyExpr,
  difficultyNameWithFallbackExpr,
  consensusGradeTable,
  consensusGradeJoinCondition,
} from '../shared/sql-expressions';
import { GetTicksInputSchema, BoardNameSchema, AscentFeedInputSchema } from '../../../validation/schemas';
import { escapeLikePattern } from '../../../utils/like-pattern';

// Shape of a row produced by the userAscentsFeed item mapper. Declared so
// userAscentCaptionMatches (which reuses that builder) returns a typed ascent
// row instead of unknown[]. Mirrors the GraphQL AscentFeedItem fields.
type AscentFeedRow = {
  uuid: string;
  climbUuid: string;
  climbName: string;
  setterUsername: string | null;
  boardType: string;
  boardId: number | null;
  boardDisplayName: string | null;
  layoutId: number | null;
  angle: number;
  isMirror: boolean;
  status: string;
  attemptCount: number;
  quality: number | null;
  difficulty: number | null;
  difficultyName: string | null;
  consensusDifficulty: number | null;
  consensusDifficultyName: string | null;
  qualityAverage: number | null;
  isBenchmark: boolean;
  isNoMatch: boolean;
  comment: string;
  climbedAt: string;
  frames: string | null;
};

export const tickQueries = {
  /**
   * Get ticks for the authenticated user with optional filtering by climb UUIDs
   */
  ticks: async (
    _: unknown,
    { input }: { input: { boardType: string; climbUuids?: string[] } },
    ctx: ConnectionContext,
  ): Promise<unknown[]> => {
    requireAuthenticated(ctx);
    validateInput(GetTicksInputSchema, input, 'input');

    const userId = ctx.userId!;

    // Build query conditions
    const conditions = [
      eq(dbSchema.boardseshTicks.userId, userId),
      eq(dbSchema.boardseshTicks.boardType, input.boardType),
    ];

    if (input.climbUuids && input.climbUuids.length > 0) {
      conditions.push(inArray(dbSchema.boardseshTicks.climbUuid, input.climbUuids));
    }

    // Fetch ticks with layoutId from unified board_climbs table
    const results = await db
      .select({
        tick: dbSchema.boardseshTicks,
        layoutId: dbSchema.boardClimbs.layoutId,
      })
      .from(dbSchema.boardseshTicks)
      // Resolve dedup-merged climbs: a tick may point at an alias UUID that was
      // deduplicated away (no row in board_climbs). The alias table maps it to
      // the canonical UUID, which is what board_climbs is keyed on. Ticks already
      // pointing at a canonical have a self-alias or no alias row, so COALESCE
      // falls back to the tick's own climb_uuid (identical to the old join).
      .leftJoin(
        dbSchema.boardClimbAliases,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbAliases.aliasUuid),
          eq(dbSchema.boardClimbAliases.boardType, input.boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          sql`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid}) = ${dbSchema.boardClimbs.uuid}`,
          eq(dbSchema.boardClimbs.boardType, input.boardType),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt));

    // Batch-fetch social aggregates in two grouped queries instead of running
    // a correlated subquery per row — this resolver is unbounded (no LIMIT),
    // so a user with thousands of ticks would otherwise hit thousands of
    // `comments` / `vote_counts` lookups on every accumulated-logbook refresh.
    const tickUuids = results.map((r) => r.tick.uuid);
    const [voteRows, commentRows] =
      tickUuids.length > 0
        ? await Promise.all([
            db
              .select({
                entityId: dbSchema.voteCounts.entityId,
                upvotes: dbSchema.voteCounts.upvotes,
                downvotes: dbSchema.voteCounts.downvotes,
              })
              .from(dbSchema.voteCounts)
              .where(and(eq(dbSchema.voteCounts.entityType, 'tick'), inArray(dbSchema.voteCounts.entityId, tickUuids))),
            db
              .select({
                entityId: dbSchema.comments.entityId,
                commentCount: sql<number>`COUNT(*)::int`.as('comment_count'),
              })
              .from(dbSchema.comments)
              .where(
                and(
                  eq(dbSchema.comments.entityType, 'tick'),
                  inArray(dbSchema.comments.entityId, tickUuids),
                  isNull(dbSchema.comments.deletedAt),
                ),
              )
              .groupBy(dbSchema.comments.entityId),
          ])
        : [[], []];

    const voteMap = new Map(voteRows.map((v) => [v.entityId, v]));
    const commentMap = new Map(commentRows.map((c) => [c.entityId, Number(c.commentCount)]));

    return results.map(({ tick, layoutId }) => {
      const votes = voteMap.get(tick.uuid);
      return {
        uuid: tick.uuid,
        userId: tick.userId,
        boardType: tick.boardType,
        climbUuid: tick.climbUuid,
        angle: tick.angle,
        isMirror: tick.isMirror,
        status: tick.status,
        attemptCount: tick.attemptCount,
        quality: tick.quality,
        difficulty: tick.difficulty,
        isBenchmark: tick.isBenchmark,
        comment: tick.comment,
        climbedAt: tick.climbedAt,
        createdAt: tick.createdAt,
        updatedAt: tick.updatedAt,
        sessionId: tick.sessionId,
        auroraType: tick.auroraType,
        auroraId: tick.auroraId,
        auroraSyncedAt: tick.auroraSyncedAt,
        layoutId,
        upvotes: votes ? Number(votes.upvotes) : 0,
        downvotes: votes ? Number(votes.downvotes) : 0,
        commentCount: commentMap.get(tick.uuid) ?? 0,
      };
    });
  },

  /**
   * Get ticks for a specific user (public query, no authentication required)
   */
  userTicks: async (_: unknown, { userId, boardType }: { userId: string; boardType: string }): Promise<unknown[]> => {
    validateInput(BoardNameSchema, boardType, 'boardType');

    const conditions = [eq(dbSchema.boardseshTicks.userId, userId), eq(dbSchema.boardseshTicks.boardType, boardType)];

    // Fetch ticks with layoutId from unified board_climbs table. We surface
    // `difficulty` as the raw user override (preserving the field's pre-fix
    // contract so optimistic writes don't flicker), and an additional
    // `effectiveDifficulty` that COALESCEs with the climb's consensus grade
    // for chart-bucket / aggregation consumers. NULL difficulty means "use
    // consensus" — see docs/ascents-and-attempts.md.
    const results = await db
      .select({
        tick: dbSchema.boardseshTicks,
        layoutId: dbSchema.boardClimbs.layoutId,
        effectiveDifficulty: sql<
          number | null
        >`COALESCE(${dbSchema.boardseshTicks.difficulty}, ${consensusDifficultyExpr})`,
      })
      .from(dbSchema.boardseshTicks)
      // Resolve dedup-merged climbs to their canonical UUID before joining
      // board_climbs / board_climb_stats — both live on the canonical. See the
      // `ticks` resolver for the COALESCE-fallback rationale.
      .leftJoin(
        dbSchema.boardClimbAliases,
        and(
          eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbAliases.aliasUuid),
          eq(dbSchema.boardClimbAliases.boardType, boardType),
        ),
      )
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          sql`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid}) = ${dbSchema.boardClimbs.uuid}`,
          eq(dbSchema.boardClimbs.boardType, boardType),
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
      .where(and(...conditions))
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt));

    return results.map(({ tick, layoutId, effectiveDifficulty }) => ({
      uuid: tick.uuid,
      userId: tick.userId,
      boardType: tick.boardType,
      climbUuid: tick.climbUuid,
      angle: tick.angle,
      isMirror: tick.isMirror,
      status: tick.status,
      attemptCount: tick.attemptCount,
      quality: tick.quality,
      difficulty: tick.difficulty,
      effectiveDifficulty,
      isBenchmark: tick.isBenchmark,
      comment: tick.comment,
      climbedAt: tick.climbedAt,
      createdAt: tick.createdAt,
      updatedAt: tick.updatedAt,
      sessionId: tick.sessionId,
      auroraType: tick.auroraType,
      auroraId: tick.auroraId,
      auroraSyncedAt: tick.auroraSyncedAt,
      layoutId,
    }));
  },

  /**
   * Get ascent activity feed for a specific user (public query)
   * Returns ticks with enriched climb data for display in a feed
   */
  userAscentsFeed: async (
    _: unknown,
    {
      userId,
      input,
    }: {
      userId: string;
      input?: {
        limit?: number;
        offset?: number;
        boardType?: string;
        boardTypes?: string[];
        layoutIds?: number[];
        status?: string;
        statusMode?: string;
        flashOnly?: boolean;
        climbName?: string;
        sortBy?: string;
        sortOrder?: string;
        secondarySortBy?: string;
        secondarySortOrder?: string;
        minDifficulty?: number;
        maxDifficulty?: number;
        minAngle?: number;
        maxAngle?: number;
        benchmarkOnly?: boolean;
        fromDate?: string;
        toDate?: string;
      };
    },
    ctx?: ConnectionContext,
  ): Promise<{
    items: AscentFeedRow[];
    totalCount: number;
    hasMore: boolean;
  }> => {
    // Validate and set defaults
    const validatedInput = validateInput(AscentFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;
    const boardType = validatedInput.boardType;
    const boardTypes = validatedInput.boardTypes;
    const layoutIds = validatedInput.layoutIds;
    const climbName = validatedInput.climbName;
    const sortBy = validatedInput.sortBy ?? 'recent';
    const sortOrder = validatedInput.sortOrder ?? 'desc';
    const secondarySortBy = validatedInput.secondarySortBy;
    const secondarySortOrder = validatedInput.secondarySortOrder ?? 'desc';
    const minDifficulty = validatedInput.minDifficulty;
    const maxDifficulty = validatedInput.maxDifficulty;
    const minAngle = validatedInput.minAngle;
    const maxAngle = validatedInput.maxAngle;
    const benchmarkOnly = validatedInput.benchmarkOnly ?? false;
    const fromDate = validatedInput.fromDate;
    const toDate = validatedInput.toDate;
    const legacyStatus = validatedInput.status;
    let inferredStatusMode = 'both';
    if (legacyStatus === 'attempt') {
      inferredStatusMode = 'attempt';
    } else if (legacyStatus) {
      inferredStatusMode = 'send';
    }
    const statusMode = validatedInput.statusMode ?? inferredStatusMode;
    const flashOnly = validatedInput.flashOnly ?? legacyStatus === 'flash';

    const resolvedBenchmarkExpr = sql<boolean>`CASE
      WHEN COALESCE(${dbSchema.boardClimbStats.benchmarkDifficulty}, 0) > 0 OR ${dbSchema.boardseshTicks.isBenchmark} = true THEN true
      ELSE false
    END`;

    // Filter on the effective difficulty (user override → consensus fallback) so
    // a grade-range filter doesn't silently hide ungraded ascents whose consensus
    // is in range. See docs/ascents-and-attempts.md.
    const effectiveDifficultyExpr = sql<number>`COALESCE(${dbSchema.boardseshTicks.difficulty}, ${consensusDifficultyExpr})`;

    // Build shared WHERE conditions
    const tickConditions = [
      eq(dbSchema.boardseshTicks.userId, userId),
      ...(boardType ? [eq(dbSchema.boardseshTicks.boardType, boardType)] : []),
      ...(boardTypes && boardTypes.length > 0 && !boardType
        ? [inArray(dbSchema.boardseshTicks.boardType, boardTypes)]
        : []),
      ...(minDifficulty !== undefined ? [gte(effectiveDifficultyExpr, minDifficulty)] : []),
      ...(maxDifficulty !== undefined ? [lte(effectiveDifficultyExpr, maxDifficulty)] : []),
      ...(minAngle !== undefined ? [gte(dbSchema.boardseshTicks.angle, minAngle)] : []),
      ...(maxAngle !== undefined ? [lte(dbSchema.boardseshTicks.angle, maxAngle)] : []),
      ...(fromDate ? [gte(dbSchema.boardseshTicks.climbedAt, fromDate)] : []),
      ...(toDate ? [lte(dbSchema.boardseshTicks.climbedAt, toDate + 'T23:59:59.999Z')] : []),
    ];

    if (statusMode === 'attempt') {
      tickConditions.push(eq(dbSchema.boardseshTicks.status, 'attempt'));
    } else if (statusMode === 'send') {
      tickConditions.push(
        flashOnly
          ? eq(dbSchema.boardseshTicks.status, 'flash')
          : inArray(dbSchema.boardseshTicks.status, ['flash', 'send']),
      );
    } else if (flashOnly) {
      tickConditions.push(eq(dbSchema.boardseshTicks.status, 'flash'));
    }

    if (benchmarkOnly) {
      tickConditions.push(sql`(${resolvedBenchmarkExpr}) = true`);
    }

    // Base query with JOINs (shared by count and data queries)
    const baseQuery = db
      .select({
        tick: dbSchema.boardseshTicks,
        climbName: dbSchema.boardClimbs.name,
        climbDescription: dbSchema.boardClimbs.description,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        boardName: dbSchema.userBoards.name,
        boardIsPublic: dbSchema.userBoards.isPublic,
        boardIsUnlisted: dbSchema.userBoards.isUnlisted,
        difficultyName: dbSchema.boardDifficultyGrades.boulderName,
        consensusDifficulty: consensusDifficultyExpr,
        consensusDifficultyName: consensusDifficultyNameExpr,
        resolvedIsBenchmark: resolvedBenchmarkExpr,
        qualityAverage: dbSchema.boardClimbStats.qualityAverage,
      })
      .from(dbSchema.boardseshTicks)
      .leftJoin(dbSchema.userBoards, eq(dbSchema.boardseshTicks.boardId, dbSchema.userBoards.id))
      // Resolve dedup-merged climbs to their canonical UUID before joining
      // board_climbs / board_climb_stats. See the `ticks` resolver for rationale.
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
        dbSchema.boardClimbStats,
        and(
          sql`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid}) = ${dbSchema.boardClimbStats.climbUuid}`,
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbStats.boardType),
          eq(dbSchema.boardseshTicks.angle, dbSchema.boardClimbStats.angle),
        ),
      )
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardseshTicks.difficulty, dbSchema.boardDifficultyGrades.difficulty),
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardDifficultyGrades.boardType),
        ),
      )
      .leftJoin(consensusGradeTable, consensusGradeJoinCondition);

    // Full conditions including climb name filter (requires JOIN)
    const allConditions = [
      ...tickConditions,
      ...(layoutIds && layoutIds.length > 0 ? [inArray(dbSchema.boardClimbs.layoutId, layoutIds)] : []),
      ...(climbName
        ? [
            or(
              ilike(dbSchema.boardClimbs.name, `%${escapeLikePattern(climbName)}%`),
              ilike(dbSchema.boardseshTicks.comment, `%${escapeLikePattern(climbName)}%`),
            ),
          ]
        : []),
    ];

    // Get total count
    const countQuery = db
      .select({ count: count() })
      .from(dbSchema.boardseshTicks)
      // Mirror the data query's alias resolution so count matches the rows
      // returned (climb-name filter joins on the canonical board_climbs row).
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
        dbSchema.boardClimbStats,
        and(
          sql`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid}) = ${dbSchema.boardClimbStats.climbUuid}`,
          eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbStats.boardType),
          eq(dbSchema.boardseshTicks.angle, dbSchema.boardClimbStats.angle),
        ),
      )
      .where(and(...allConditions));

    const countResult = await countQuery;
    const totalCount = Number(countResult[0]?.count || 0);

    const buildOrderClause = (field: string, direction: string) => {
      const dir = direction === 'asc' ? 'asc' : 'desc';
      switch (field) {
        case 'climbName':
          return sql`${dbSchema.boardClimbs.name} ${sql.raw(dir)} nulls last`;
        case 'loggedGrade':
        case 'easiest':
        case 'hardest':
          return sql`${dbSchema.boardseshTicks.difficulty} ${sql.raw(dir)} nulls last`;
        case 'consensusGrade':
          return sql`${consensusDifficultyExpr} ${sql.raw(dir)} nulls last`;
        case 'effectiveGrade':
          // User's logged grade, falling back to the consensus when they didn't
          // log one, so an ungraded tick ranks as if logged == consensus.
          return sql`${effectiveDifficultyExpr} ${sql.raw(dir)} nulls last`;
        case 'attemptCount':
        case 'mostAttempts':
          return sql`${dbSchema.boardseshTicks.attemptCount} ${sql.raw(dir)} nulls last`;
        case 'date':
        case 'recent':
        default:
          return sql`${dbSchema.boardseshTicks.climbedAt} ${sql.raw(dir)} nulls last`;
      }
    };

    let resolvedPrimarySort: { field: string; direction: string };
    if (sortBy === 'recent') {
      resolvedPrimarySort = { field: 'date', direction: sortOrder };
    } else if (sortBy === 'hardest') {
      // Hardest = the climber's effective grade (their logged grade, or the
      // consensus when they didn't grade it) desc. That's the same grade the
      // logbook row shows, so the list reads in order while scrolling. Date
      // breaks ties (appended below). Shared by web + mobile.
      resolvedPrimarySort = { field: 'effectiveGrade', direction: 'desc' };
    } else if (sortBy === 'easiest') {
      resolvedPrimarySort = { field: 'loggedGrade', direction: 'asc' };
    } else if (sortBy === 'mostAttempts') {
      resolvedPrimarySort = { field: 'attemptCount', direction: 'desc' };
    } else {
      resolvedPrimarySort = { field: sortBy, direction: sortOrder };
    }

    let resolvedSecondarySort: { field: string; direction: string } | null;
    if (secondarySortBy) {
      resolvedSecondarySort = { field: secondarySortBy, direction: secondarySortOrder };
    } else {
      resolvedSecondarySort = null;
    }

    const orderClauses = [
      buildOrderClause(resolvedPrimarySort.field, resolvedPrimarySort.direction),
      ...(resolvedSecondarySort
        ? [buildOrderClause(resolvedSecondarySort.field, resolvedSecondarySort.direction)]
        : []),
      desc(dbSchema.boardseshTicks.climbedAt),
      desc(dbSchema.boardseshTicks.uuid),
    ];

    // Fetch paginated results
    const results = await baseQuery
      .where(and(...allConditions))
      .orderBy(...orderClauses)
      .limit(limit)
      .offset(offset);

    // Map results to response format
    const items = results.map(
      ({
        tick,
        climbName,
        climbDescription,
        setterUsername,
        layoutId,
        frames,
        boardName,
        boardIsPublic,
        boardIsUnlisted,
        difficultyName,
        consensusDifficulty,
        consensusDifficultyName,
        resolvedIsBenchmark,
        qualityAverage,
      }) => {
        const canShowBoard =
          tick.boardId != null && (ctx?.userId === userId || (boardIsPublic === true && boardIsUnlisted !== true));
        return {
          uuid: tick.uuid,
          climbUuid: tick.climbUuid,
          climbName: climbName || 'Unknown Climb',
          setterUsername,
          boardType: tick.boardType,
          boardId: canShowBoard ? tick.boardId : null,
          boardDisplayName: canShowBoard ? boardName : null,
          layoutId,
          angle: tick.angle,
          // is_mirror is nullable (default false, no NOT NULL); GraphQL exposes it
          // as Boolean!, so coerce a null to false here.
          isMirror: tick.isMirror ?? false,
          status: tick.status,
          attemptCount: tick.attemptCount,
          quality: tick.quality,
          difficulty: tick.difficulty,
          difficultyName,
          consensusDifficulty:
            consensusDifficulty !== null && consensusDifficulty !== undefined ? Number(consensusDifficulty) : null,
          consensusDifficultyName,
          isBenchmark: Boolean(resolvedIsBenchmark),
          isNoMatch: isNoMatchClimb(climbDescription),
          qualityAverage: qualityAverage != null ? Number(qualityAverage) : null,
          comment: tick.comment || '',
          climbedAt: tick.climbedAt,
          frames,
        };
      },
    );

    return {
      items,
      totalCount,
      hasMore: offset + items.length < totalCount,
    };
  },

  /**
   * Suggest which of a climber's logged ascents a shared reel is about, by
   * pulling the climb name out of the caption's quotes and looking it up in their
   * logbook (the mobile share-beta picker). Public, like userAscentsFeed.
   *
   * Boardsesh's share caption embeds the climb name in double quotes
   * (`"Purple Nurple" @ 40° on the …`), so we extract the quoted name(s) and fetch
   * the matching send/flash ascents — with board art — by the indexed, per-user
   * climbName filter (no whole-logbook scan), then keep exact name matches. A
   * caption with no quoted climb name (e.g. a non-Boardsesh reel, or a MoonBoard
   * caption, which isn't quoted) yields no suggestions; the climber searches.
   */
  userAscentCaptionMatches: async (
    _: unknown,
    { userId, caption }: { userId: string; caption: string },
    ctx?: ConnectionContext,
  ): Promise<AscentFeedRow[]> => {
    // Public resolver that fans out to DB queries — rate-limit it like the other
    // public reads (ctx is always present for a real request; tests pass none).
    if (ctx) await applyRateLimit(ctx, 10, 'userAscentCaptionMatches');

    // Cap the caption before any scanning so a multi-MB payload can't make
    // matchAll/extract walk the whole string. 2 KB is ample for a real reel.
    const MAX_CAPTION_LENGTH = 2048;
    const MAX_NAME_LOOKUPS = 4;
    const MAX_SUGGESTIONS = 8;

    const safeCaption = caption.slice(0, MAX_CAPTION_LENGTH);
    const quotedNames = extractQuotedClimbNames(safeCaption);
    if (quotedNames.length === 0) return [];

    // statusMode 'send' = flash + send (beta attaches to ascents, not attempts,
    // so a flash-only climb is still included). The climbName filter is an
    // indexed, per-user ILIKE that returns a handful of rows — not the whole
    // logbook — and resolves aliased/deduped climbs to their canonical name.
    // Lookups run in parallel (captions occasionally quote more than one climb).
    const feeds = await Promise.all(
      quotedNames
        .slice(0, MAX_NAME_LOOKUPS)
        .map((quotedName) =>
          tickQueries.userAscentsFeed(
            _,
            { userId, input: { climbName: quotedName, statusMode: 'send', limit: 50 } },
            ctx,
          ),
        ),
    );
    const gathered = feeds.flatMap((feed) => feed.items);

    // Exact-match the quoted name(s) against the fetched rows — drops ILIKE
    // substring over-matches and comment-only hits — then de-dupe by climb
    // (keeping the most recent send, since the feed is recency-sorted) and rank.
    return matchClimbsToCaption(safeCaption, gathered).slice(0, MAX_SUGGESTIONS);
  },

  /**
   * Get ascent activity feed grouped by climb and day (public query)
   * Groups multiple attempts on the same climb on the same day into a single entry.
   *
   * Pagination is applied to (climbUuid, day) groups directly in SQL so the
   * resolver returns the correct totalCount and never silently truncates a
   * user's history.
   */
  userGroupedAscentsFeed: async (
    _: unknown,
    { userId, input }: { userId: string; input?: { limit?: number; offset?: number } },
  ): Promise<{
    groups: unknown[];
    totalCount: number;
    hasMore: boolean;
  }> => {
    // Validate and set defaults
    const validatedInput = validateInput(AscentFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;

    // boardsesh_ticks.climbed_at is `timestamp without time zone` storing the
    // climber's wall-clock time at the moment of the tick (the rest of the
    // codebase reads it back via `dayjs(...).utc(true)` to preserve that wall
    // clock — see ascents-feed.tsx). Group by the literal stored date so a
    // session ending at 11pm local doesn't bleed into the next day.
    const dayExpr = sql<string>`to_char(${dbSchema.boardseshTicks.climbedAt}, 'YYYY-MM-DD')`;

    // 1) Page of (climbUuid, day) keys, ordered by latest activity in that group.
    //    Bounds the SQL fetch to exactly the groups we'll return.
    const pageGroups = await db
      .select({
        climbUuid: dbSchema.boardseshTicks.climbUuid,
        day: dayExpr.as('day'),
        latestClimbedAt: sql<string>`max(${dbSchema.boardseshTicks.climbedAt})`.as('latest_climbed_at'),
      })
      .from(dbSchema.boardseshTicks)
      .where(eq(dbSchema.boardseshTicks.userId, userId))
      .groupBy(dbSchema.boardseshTicks.climbUuid, dayExpr)
      .orderBy(sql`max(${dbSchema.boardseshTicks.climbedAt}) desc`)
      .limit(limit)
      .offset(offset);

    // 2) True total group count — runs in parallel with the data fetch below.
    const totalCountPromise = db.select({ count: count() }).from(
      db
        .select({
          climbUuid: dbSchema.boardseshTicks.climbUuid,
          day: dayExpr.as('day'),
        })
        .from(dbSchema.boardseshTicks)
        .where(eq(dbSchema.boardseshTicks.userId, userId))
        .groupBy(dbSchema.boardseshTicks.climbUuid, dayExpr)
        .as('group_keys'),
    );

    if (pageGroups.length === 0) {
      const totalCountResult = await totalCountPromise;
      const totalCount = Number(totalCountResult[0]?.count ?? 0);
      return { groups: [], totalCount, hasMore: false };
    }

    // 3) Fetch every tick belonging to this page of groups in a single query.
    //    We narrow by climbUuid + a date window first, then refilter by the
    //    exact (climbUuid, day) tuples in JS — Drizzle has no clean tuple-IN
    //    helper, and pages are small (≤ limit groups) so the over-fetch is
    //    bounded.
    const climbUuidsInPage = Array.from(new Set(pageGroups.map((g) => g.climbUuid)));
    const daysInPage = pageGroups.map((g) => g.day).sort();
    const minDay = daysInPage[0];
    const maxDay = daysInPage[daysInPage.length - 1];
    const pageKeySet = new Set(pageGroups.map((g) => `${g.climbUuid}-${g.day}`));

    // Use timestamp range instead of to_char() in WHERE so Postgres can use
    // the (user_id, climbed_at) btree index for the date window filter.
    const minTimestamp = `${minDay}T00:00:00`;
    const maxTimestamp = `${maxDay}T23:59:59.999999`;

    const tickRows = await db
      .select({
        tick: dbSchema.boardseshTicks,
        climbName: dbSchema.boardClimbs.name,
        climbDescription: dbSchema.boardClimbs.description,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        difficultyName: difficultyNameWithFallbackExpr,
        day: dayExpr.as('day'),
      })
      .from(dbSchema.boardseshTicks)
      // Resolve dedup-merged climbs to their canonical UUID before joining
      // board_climbs / board_climb_stats. See the `ticks` resolver for rationale.
      // The (climbUuid, day) grouping itself stays keyed on the tick's own
      // climb_uuid, so merged and canonical ticks remain distinct groups — we
      // only enrich each group with the canonical climb's name/grade/stats.
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
          eq(dbSchema.boardseshTicks.userId, userId),
          inArray(dbSchema.boardseshTicks.climbUuid, climbUuidsInPage),
          gte(dbSchema.boardseshTicks.climbedAt, minTimestamp),
          lte(dbSchema.boardseshTicks.climbedAt, maxTimestamp),
        ),
      )
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt));

    type AscentItem = {
      uuid: string;
      climbUuid: string;
      climbName: string;
      setterUsername: string | null;
      boardType: string;
      layoutId: number | null;
      angle: number;
      isMirror: boolean;
      status: string;
      attemptCount: number;
      quality: number | null;
      difficulty: number | null;
      difficultyName: string | null;
      isBenchmark: boolean;
      isNoMatch: boolean;
      comment: string;
      climbedAt: string;
      frames: string | null;
    };

    type GroupedAscent = {
      key: string;
      climbUuid: string;
      climbName: string;
      setterUsername: string | null;
      boardType: string;
      layoutId: number | null;
      angle: number;
      isMirror: boolean;
      frames: string | null;
      difficultyName: string | null;
      isBenchmark: boolean;
      isNoMatch: boolean;
      date: string;
      items: AscentItem[];
      flashCount: number;
      sendCount: number;
      attemptCount: number;
      bestQuality: number | null;
      latestComment: string | null;
    };

    const groupMap = new Map<string, GroupedAscent>();

    for (const {
      tick,
      climbName,
      climbDescription,
      setterUsername,
      layoutId,
      frames,
      difficultyName,
      day,
    } of tickRows) {
      const key = `${tick.climbUuid}-${day}`;
      // Skip ticks that fell inside the date window but belong to a different group.
      if (!pageKeySet.has(key)) continue;

      const isNoMatch = isNoMatchClimb(climbDescription);

      const item: AscentItem = {
        uuid: tick.uuid,
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
        isNoMatch,
        comment: tick.comment || '',
        climbedAt: tick.climbedAt,
        frames,
      };

      let group = groupMap.get(key);
      if (!group) {
        group = {
          key,
          climbUuid: tick.climbUuid,
          climbName: climbName || 'Unknown Climb',
          setterUsername,
          boardType: tick.boardType,
          layoutId,
          angle: tick.angle,
          isMirror: tick.isMirror ?? false,
          frames,
          difficultyName,
          isBenchmark: tick.isBenchmark ?? false,
          isNoMatch,
          date: day,
          items: [],
          flashCount: 0,
          sendCount: 0,
          attemptCount: 0,
          bestQuality: null,
          latestComment: null,
        };
        groupMap.set(key, group);
      }

      group.items.push(item);

      if (tick.status === 'flash') {
        group.flashCount++;
      } else if (tick.status === 'send') {
        group.sendCount++;
      } else {
        group.attemptCount++;
      }

      if (tick.quality !== null) {
        if (group.bestQuality === null || tick.quality > group.bestQuality) {
          group.bestQuality = tick.quality;
        }
      }

      if (tick.comment && !group.latestComment) {
        group.latestComment = tick.comment;
      }
    }

    // Preserve the SQL-decided page ordering (by latest activity).
    const groups = pageGroups
      .map((pg) => groupMap.get(`${pg.climbUuid}-${pg.day}`))
      .filter((g): g is GroupedAscent => g !== undefined);

    const totalCountResult = await totalCountPromise;
    const totalCount = Number(totalCountResult[0]?.count ?? 0);

    return {
      groups,
      totalCount,
      hasMore: offset + groups.length < totalCount,
    };
  },

  /**
   * Get a user's percentile ranking based on distinct climbs ascended (sends + flashes only).
   */
  userClimbPercentile: async (_: unknown, { userId }: { userId: string }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, 10, 'userClimbPercentile');

    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      return { totalDistinctClimbs: 0, percentile: 0, totalActiveUsers: 0 };
    }

    const [snapshot] = await db
      .select({
        totalDistinctClimbs: dbSchema.userClimbPercentiles.totalDistinctClimbs,
        percentile: dbSchema.userClimbPercentiles.percentile,
        totalActiveUsers: dbSchema.userClimbPercentiles.totalActiveUsers,
      })
      .from(dbSchema.userClimbPercentiles)
      .where(eq(dbSchema.userClimbPercentiles.userId, userId))
      .limit(1);

    if (snapshot) {
      return {
        totalDistinctClimbs: Number(snapshot.totalDistinctClimbs ?? 0),
        percentile: Number(snapshot.percentile ?? 0),
        totalActiveUsers: Number(snapshot.totalActiveUsers ?? 0),
      };
    }

    const [summary] = await db
      .select({
        totalActiveUsers: dbSchema.userClimbPercentiles.totalActiveUsers,
      })
      .from(dbSchema.userClimbPercentiles)
      .limit(1);

    return {
      totalDistinctClimbs: 0,
      percentile: 0,
      totalActiveUsers: Number(summary?.totalActiveUsers ?? 0),
    };
  },

  /**
   * Get profile statistics with distinct climb counts per grade
   * Groups by board type and layout, counting unique climbs per difficulty grade
   */
  userProfileStats: async (
    _: unknown,
    { userId }: { userId: string },
  ): Promise<{
    totalDistinctClimbs: number;
    layoutStats: Array<{
      layoutKey: string;
      boardType: string;
      layoutId: number | null;
      distinctClimbCount: number;
      gradeCounts: Array<{ grade: string; count: number }>;
    }>;
  }> => {
    // Validate userId
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      return { totalDistinctClimbs: 0, layoutStats: [] };
    }

    const boardTypes = SUPPORTED_BOARDS;
    const layoutStatsMap: Record<
      string,
      {
        boardType: string;
        layoutId: number | null;
        distinctClimbCount: number;
        gradeCounts: Array<{ grade: string; count: number }>;
      }
    > = {};
    const allClimbUuids = new Set<string>();

    // Helper function to fetch stats for a single board type
    const fetchBoardStats = async (boardType: BoardName) => {
      // COALESCE the tick's own difficulty with the climb's consensus difficulty so a
      // tick logged without a user-picked grade still buckets into the consensus grade
      // (a NULL stored value means "use consensus" — see the matching join in userTicks).
      const effectiveDifficultyExpr = sql<
        number | null
      >`COALESCE(${dbSchema.boardseshTicks.difficulty}, ${consensusDifficultyExpr})`;

      const baseConditions = and(
        eq(dbSchema.boardseshTicks.userId, userId),
        eq(dbSchema.boardseshTicks.boardType, boardType),
        ne(dbSchema.boardseshTicks.status, 'attempt'),
      );

      // Run three queries in parallel for this board type:
      // - gradeResults: counts per (layout, effective difficulty) for the chart
      // - distinctByLayout: per-layout distinct climb count (correct even when one
      //   climb appears across multiple grade buckets — e.g. logged at multiple
      //   angles whose consensus differs)
      // - distinctClimbs: global distinct climbs for `totalDistinctClimbs`
      const [gradeResults, distinctByLayout, distinctClimbs] = await Promise.all([
        db
          .select({
            layoutId: dbSchema.boardClimbs.layoutId,
            difficulty: effectiveDifficultyExpr.as('effective_difficulty'),
            distinctCount: sql<number>`count(distinct ${dbSchema.boardseshTicks.climbUuid})`.as('distinct_count'),
          })
          .from(dbSchema.boardseshTicks)
          // Resolve dedup-merged climbs to their canonical UUID so the layout +
          // stats lookups land on the canonical row. See the `ticks` resolver.
          .leftJoin(
            dbSchema.boardClimbAliases,
            and(
              eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbAliases.aliasUuid),
              eq(dbSchema.boardClimbAliases.boardType, boardType),
            ),
          )
          .leftJoin(
            dbSchema.boardClimbs,
            and(
              sql`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid}) = ${dbSchema.boardClimbs.uuid}`,
              eq(dbSchema.boardClimbs.boardType, boardType),
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
          .where(baseConditions)
          .groupBy(dbSchema.boardClimbs.layoutId, effectiveDifficultyExpr),

        db
          .select({
            layoutId: dbSchema.boardClimbs.layoutId,
            distinctCount: sql<number>`count(distinct ${dbSchema.boardseshTicks.climbUuid})`.as('distinct_count'),
          })
          .from(dbSchema.boardseshTicks)
          .leftJoin(
            dbSchema.boardClimbAliases,
            and(
              eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbAliases.aliasUuid),
              eq(dbSchema.boardClimbAliases.boardType, boardType),
            ),
          )
          .leftJoin(
            dbSchema.boardClimbs,
            and(
              sql`COALESCE(${dbSchema.boardClimbAliases.canonicalUuid}, ${dbSchema.boardseshTicks.climbUuid}) = ${dbSchema.boardClimbs.uuid}`,
              eq(dbSchema.boardClimbs.boardType, boardType),
            ),
          )
          .where(baseConditions)
          .groupBy(dbSchema.boardClimbs.layoutId),

        db
          .selectDistinct({ climbUuid: dbSchema.boardseshTicks.climbUuid })
          .from(dbSchema.boardseshTicks)
          .where(baseConditions),
      ]);

      return { gradeResults, distinctByLayout, distinctClimbs, boardType };
    };

    // Fetch stats for all board types in parallel
    const boardResults = await Promise.all(boardTypes.map(fetchBoardStats));

    const ensureLayoutEntry = (boardType: string, layoutId: number | null) => {
      const layoutKey = `${boardType}-${layoutId ?? 'unknown'}`;
      if (!layoutStatsMap[layoutKey]) {
        layoutStatsMap[layoutKey] = { boardType, layoutId, distinctClimbCount: 0, gradeCounts: [] };
      }
      return layoutStatsMap[layoutKey];
    };

    // Process results from all boards
    for (const { gradeResults, distinctByLayout, distinctClimbs, boardType } of boardResults) {
      for (const row of distinctClimbs) {
        allClimbUuids.add(row.climbUuid);
      }

      // Per-layout distinct climb count — separate sub-query so a climb logged at
      // multiple angles with different consensus grades only counts once.
      for (const row of distinctByLayout) {
        const entry = ensureLayoutEntry(boardType, row.layoutId);
        entry.distinctClimbCount = Number(row.distinctCount);
      }

      // Per-(layout, effective grade) counts for the chart bucketing.
      for (const row of gradeResults) {
        const entry = ensureLayoutEntry(boardType, row.layoutId);
        if (row.difficulty !== null) {
          entry.gradeCounts.push({
            grade: String(row.difficulty),
            count: Number(row.distinctCount),
          });
        }
      }
    }

    const layoutStats = Object.entries(layoutStatsMap).map(([layoutKey, stats]) => ({
      layoutKey,
      boardType: stats.boardType,
      layoutId: stats.layoutId,
      distinctClimbCount: stats.distinctClimbCount,
      gradeCounts: stats.gradeCounts.sort((a, b) => parseInt(a.grade) - parseInt(b.grade)),
    }));

    return {
      totalDistinctClimbs: allClimbUuids.size,
      layoutStats,
    };
  },
};
