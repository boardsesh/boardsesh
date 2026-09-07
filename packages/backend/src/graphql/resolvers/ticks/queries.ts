import { eq, ne, and, or, desc, inArray, isNull, sql, count, ilike, gte, lte } from 'drizzle-orm';
import {
  type ConnectionContext,
  type BoardName,
  type RenderBoardConfig,
  SUPPORTED_BOARDS,
  matchClimbsToCaption,
  extractQuotedClimbNames,
} from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { toConfidenceTier, notAuroraTwinDuplicate, withSerialPlan } from '@boardsesh/db/queries';
import {
  requireAuthenticated,
  applyRateLimit,
  validateInput,
  isNoMatchClimb,
  usesAuroraNoMatchDescription,
} from '../shared/helpers';
import { fetchOwnerBoards, toTickBoardCandidate } from '../shared/render-board';
import { resolveRenderBoard } from '@boardsesh/board-config';
import {
  consensusDifficultyNameExpr,
  consensusDifficultyExpr,
  difficultyNameWithFallbackExpr,
  consensusGradeTable,
  consensusGradeJoinCondition,
  boardseshDifficultyExpr,
  boardseshConfidenceExpr,
  boardseshGradeTickJoin,
} from '../shared/sql-expressions';

// The `board_climb_grades` join shape lives in ONE place (boardseshGradeTickJoin).
// These queries join the real (unaliased) tables, so pass their table names.
const BOARDSESH_GRADE_TICK_JOIN = boardseshGradeTickJoin({
  ticks: 'boardsesh_ticks',
  grades: 'board_climb_grades',
  aliases: 'board_climb_aliases',
});
import type { z } from 'zod';
import { GetTicksInputSchema, BoardNameSchema, AscentFeedInputSchema } from '../../../validation/schemas';
import { escapeLikePattern } from '../../../utils/like-pattern';
import { extractInstagramHandle } from '../beta-videos/queries';

// Benchmark resolution shared by the flat and grouped ascent feeds: a climb
// counts as benchmark when the stats row says so or the tick itself was
// imported as one.
const resolvedBenchmarkExpr = sql<boolean>`CASE
  WHEN COALESCE(${dbSchema.boardClimbStats.benchmarkDifficulty}, 0) > 0 OR ${dbSchema.boardseshTicks.isBenchmark} = true THEN true
  ELSE false
END`;

// Filter on the effective difficulty (user override → consensus fallback) so a
// grade-range filter doesn't silently hide ungraded ascents whose consensus is
// in range. See docs/ascents-and-attempts.md.
const effectiveDifficultyExpr = sql<number>`COALESCE(${dbSchema.boardseshTicks.difficulty}, ${consensusDifficultyExpr})`;

// A tick pulled from Kilter carries no per-tick quality, but the climber's own
// star rating for that (climb, angle) may already live in board_climb_ratings
// (kilter-sync writes it there, keyed by board_type/climb_uuid/angle/user_id).
// Join on the tick's OWN user + raw climb_uuid so a public viewer sees the
// tick owner's synced rating, and expose it as `effectiveQuality`
// (COALESCE(quality, rating)) — the same raw-vs-effective split as
// `difficulty`/`effectiveDifficulty`, so the per-tick `quality` stays the raw
// user value for edit/optimistic flows. Ratings are already 1–5 native (DB
// check constraint), so there's nothing to rescale. The unique index
// `board_climb_ratings_user_climb_angle_idx` on exactly
// (board_type, climb_uuid, angle, user_id) — declared in
// packages/db/src/schema/boards/unified.ts — makes this a 1:1 left join that
// never multiplies rows and is fully index-backed.
//
// Detached ratings are excluded. When Kilter sends a REMOVE for a rating,
// kilter-sync soft-detaches the row (kilter_id NULL + kilter_detached_at
// stamped) instead of deleting it, so the climber's own edits survive a
// PowerSync snapshot re-delivery. But a rating the climber deleted upstream
// must stop feeding effectiveQuality: unlike a tick, every field on this row
// comes from the Kilter payload, and Kilter never sends another PUT for a
// rating it has deleted — so without this predicate the stale star would show
// on the ascent forever. A REMOVE-then-PUT redelivery re-adopts the row and
// clears the marker, so a live rating is unaffected.
//
// The marker is Kilter-specific but this predicate is not: a marked row is
// hidden whatever its rating's origin. That is correct today because
// kilter-sync is the only writer of this table. The day an Aurora writer
// lands, revisit it — an Aurora-origin row that adopted a kilter_id and then
// took a Kilter REMOVE would be hidden even though its Aurora rating is live.
const boardClimbRatingsJoinCondition = and(
  eq(dbSchema.boardseshTicks.boardType, dbSchema.boardClimbRatings.boardType),
  eq(dbSchema.boardseshTicks.climbUuid, dbSchema.boardClimbRatings.climbUuid),
  eq(dbSchema.boardseshTicks.angle, dbSchema.boardClimbRatings.angle),
  eq(dbSchema.boardseshTicks.userId, dbSchema.boardClimbRatings.userId),
  isNull(dbSchema.boardClimbRatings.kilterDetachedAt),
);

const effectiveQualityExpr = sql<
  number | null
>`COALESCE(${dbSchema.boardseshTicks.quality}, ${dbSchema.boardClimbRatings.rating})`;

// The validated AscentFeedInput both feeds filter on — inferred from the zod
// schema so a new filter field can't silently diverge from validation.
type AscentFeedFilterInput = z.infer<typeof AscentFeedInputSchema>;

/**
 * WHERE conditions over the ticks table (+ stats/consensus joins for grade and
 * benchmark filters) shared by userAscentsFeed and userGroupedAscentsFeed so
 * the two feeds can never disagree about what a filter means.
 */
function buildAscentTickConditions(validated: AscentFeedFilterInput, userId: string) {
  const legacyStatus = validated.status;
  let inferredStatusMode = 'both';
  if (legacyStatus === 'attempt') {
    inferredStatusMode = 'attempt';
  } else if (legacyStatus) {
    inferredStatusMode = 'send';
  }
  const statusMode = validated.statusMode ?? inferredStatusMode;
  const flashOnly = validated.flashOnly ?? legacyStatus === 'flash';

  const conditions = [
    eq(dbSchema.boardseshTicks.userId, userId),
    // Aurora's own duplicate ascents count once (#3535). Sits in the SHARED
    // conditions so the page query, the count query and the grouped feed's
    // per-group tick fetch all collapse the same twins — a feed that showed a
    // send once but counted it four times would be its own bug.
    notAuroraTwinDuplicate(dbSchema.boardseshTicks),
    ...(validated.boardType ? [eq(dbSchema.boardseshTicks.boardType, validated.boardType)] : []),
    ...(validated.boardTypes && validated.boardTypes.length > 0 && !validated.boardType
      ? [inArray(dbSchema.boardseshTicks.boardType, validated.boardTypes)]
      : []),
    ...(validated.minDifficulty !== undefined ? [gte(effectiveDifficultyExpr, validated.minDifficulty)] : []),
    ...(validated.maxDifficulty !== undefined ? [lte(effectiveDifficultyExpr, validated.maxDifficulty)] : []),
    ...(validated.minAngle !== undefined ? [gte(dbSchema.boardseshTicks.angle, validated.minAngle)] : []),
    ...(validated.maxAngle !== undefined ? [lte(dbSchema.boardseshTicks.angle, validated.maxAngle)] : []),
    ...(validated.fromDate ? [gte(dbSchema.boardseshTicks.climbedAt, validated.fromDate)] : []),
    ...(validated.toDate ? [lte(dbSchema.boardseshTicks.climbedAt, validated.toDate + 'T23:59:59.999Z')] : []),
  ];

  if (statusMode === 'attempt') {
    conditions.push(eq(dbSchema.boardseshTicks.status, 'attempt'));
  } else if (statusMode === 'send') {
    conditions.push(
      flashOnly
        ? eq(dbSchema.boardseshTicks.status, 'flash')
        : inArray(dbSchema.boardseshTicks.status, ['flash', 'send']),
    );
  } else if (flashOnly) {
    conditions.push(eq(dbSchema.boardseshTicks.status, 'flash'));
  }

  if (validated.benchmarkOnly) {
    conditions.push(sql`(${resolvedBenchmarkExpr}) = true`);
  }

  return conditions;
}

/** Conditions that need the canonical board_climbs join (layout + name search). */
function buildAscentClimbConditions(validated: AscentFeedFilterInput) {
  return [
    ...(validated.layoutIds && validated.layoutIds.length > 0
      ? [inArray(dbSchema.boardClimbs.layoutId, validated.layoutIds)]
      : []),
    ...(validated.climbName
      ? [
          or(
            ilike(dbSchema.boardClimbs.name, `%${escapeLikePattern(validated.climbName)}%`),
            ilike(dbSchema.boardseshTicks.comment, `%${escapeLikePattern(validated.climbName)}%`),
          ),
        ]
      : []),
  ];
}

/**
 * Which of these climbs carry a beta video of THIS user's — created by them,
 * matching their Instagram handle (legacy synced rows have tick_uuid NULL), or
 * directly attached to one of the given ticks. Ownership mirrors userBetaLinks
 * (the profile beta shelf). One profile lookup + one links query per call.
 * Returns `boardType:climbUuid` keys.
 */
async function fetchUserBetaClimbKeys(userId: string, climbUuids: string[], tickUuids: string[]): Promise<Set<string>> {
  if (climbUuids.length === 0) return new Set();
  const profileRows = await db
    .select({ instagramUrl: dbSchema.userProfiles.instagramUrl })
    .from(dbSchema.userProfiles)
    .where(eq(dbSchema.userProfiles.userId, userId))
    .limit(1);
  const igHandle = extractInstagramHandle(profileRows[0]?.instagramUrl ?? null);
  // createdByUserId is unconditional, so this array is never empty — or()
  // always gets at least one condition (single-arg or() is valid but don't
  // let a refactor remove the guaranteed first element).
  const ownershipConditions = [
    eq(dbSchema.boardBetaLinks.createdByUserId, userId),
    ...(tickUuids.length > 0 ? [inArray(dbSchema.boardBetaLinks.tickUuid, tickUuids)] : []),
    ...(igHandle ? [eq(dbSchema.boardBetaLinks.foreignUsername, igHandle)] : []),
  ];
  const betaLinkRows = await db
    .select({ boardType: dbSchema.boardBetaLinks.boardType, climbUuid: dbSchema.boardBetaLinks.climbUuid })
    .from(dbSchema.boardBetaLinks)
    .where(and(inArray(dbSchema.boardBetaLinks.climbUuid, climbUuids), or(...ownershipConditions)));
  return new Set(betaLinkRows.map((row) => `${row.boardType}:${row.climbUuid}`));
}

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
  renderBoard: RenderBoardConfig | null;
  angle: number;
  isMirror: boolean;
  status: string;
  attemptCount: number;
  quality: number | null;
  effectiveQuality: number | null;
  difficulty: number | null;
  difficultyName: string | null;
  consensusDifficulty: number | null;
  consensusDifficultyName: string | null;
  boardseshDifficulty: number | null;
  boardseshConfidence: string | null;
  qualityAverage: number | null;
  isBenchmark: boolean;
  isNoMatch: boolean;
  comment: string;
  climbedAt: string;
  frames: string | null;
  hasBetaVideo: boolean;
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
      // Aurora's own duplicate ascents show up once (#3535).
      notAuroraTwinDuplicate(dbSchema.boardseshTicks),
    ];

    if (input.climbUuids && input.climbUuids.length > 0) {
      conditions.push(inArray(dbSchema.boardseshTicks.climbUuid, input.climbUuids));
    }

    // Fetch ticks with layoutId from unified board_climbs table
    const results = await db
      .select({
        tick: dbSchema.boardseshTicks,
        layoutId: dbSchema.boardClimbs.layoutId,
        boardseshDifficulty: boardseshDifficultyExpr,
        boardseshConfidence: boardseshConfidenceExpr,
        effectiveQuality: effectiveQualityExpr,
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
      // Boardsesh grade for this tick's climb at the tick's OWN angle (aliases
      // resolved via the join above). LEFT JOIN so an ungraded climb still returns.
      .leftJoin(dbSchema.boardClimbGrades, BOARDSESH_GRADE_TICK_JOIN)
      // Synced-rating fallback for quality — see boardClimbRatingsJoinCondition.
      .leftJoin(dbSchema.boardClimbRatings, boardClimbRatingsJoinCondition)
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

    return results.map(({ tick, layoutId, boardseshDifficulty, boardseshConfidence, effectiveQuality }) => {
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
        effectiveQuality: effectiveQuality != null ? Number(effectiveQuality) : null,
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
        // Boardsesh grade fallback fields (nullable). COALESCE(universal, local)
        // is doublePrecision → real JS number, but coerce defensively.
        boardseshDifficulty: boardseshDifficulty == null ? null : Number(boardseshDifficulty),
        boardseshConfidence: toConfidenceTier(boardseshConfidence),
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

    const conditions = [
      eq(dbSchema.boardseshTicks.userId, userId),
      eq(dbSchema.boardseshTicks.boardType, boardType),
      // Aurora's own duplicate ascents count once (#3535). This resolver feeds
      // the You page's send totals and grade charts via deriveProfileViewModel,
      // so a twin left in here inflates every one of those numbers.
      notAuroraTwinDuplicate(dbSchema.boardseshTicks),
    ];

    // Fetch ticks with layoutId from unified board_climbs table. We surface
    // `difficulty` as the raw user override (preserving the field's pre-fix
    // contract so optimistic writes don't flicker), and an additional
    // `effectiveDifficulty` that COALESCEs with the climb's consensus grade
    // for chart-bucket / aggregation consumers. NULL difficulty means "use
    // consensus" — see docs/ascents-and-attempts.md.
    // Unbounded (no LIMIT) over one user's whole logbook, fanning out through
    // five LEFT JOINs — board_climbs and board_climb_stats are the big ones.
    // Production picks a parallel hash join for that shape, and enough
    // concurrent profile loads exhaust Postgres's DSM on Railway's small
    // /dev/shm (Sentry BOARDSESH-AK, pgCode 53100 — the largest remaining
    // source of it, #4528). Same guard the You-page fan-out below uses; a
    // serial plan only costs latency, it can't change the rows.
    const results = await withSerialPlan(db, (transactionDb) =>
      transactionDb
        .select({
          tick: dbSchema.boardseshTicks,
          layoutId: dbSchema.boardClimbs.layoutId,
          effectiveDifficulty: sql<
            number | null
          >`COALESCE(${dbSchema.boardseshTicks.difficulty}, ${consensusDifficultyExpr})`,
          boardseshDifficulty: boardseshDifficultyExpr,
          boardseshConfidence: boardseshConfidenceExpr,
          effectiveQuality: effectiveQualityExpr,
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
        // Boardsesh grade at the tick's OWN angle (aliases resolved above). LEFT JOIN
        // so an ungraded climb still returns; the grade fields come back NULL.
        .leftJoin(dbSchema.boardClimbGrades, BOARDSESH_GRADE_TICK_JOIN)
        // Synced-rating fallback for quality — see boardClimbRatingsJoinCondition.
        .leftJoin(dbSchema.boardClimbRatings, boardClimbRatingsJoinCondition)
        .where(and(...conditions))
        .orderBy(desc(dbSchema.boardseshTicks.climbedAt)),
    );

    return results.map(
      ({ tick, layoutId, effectiveDifficulty, boardseshDifficulty, boardseshConfidence, effectiveQuality }) => ({
        uuid: tick.uuid,
        userId: tick.userId,
        boardType: tick.boardType,
        climbUuid: tick.climbUuid,
        angle: tick.angle,
        isMirror: tick.isMirror,
        status: tick.status,
        attemptCount: tick.attemptCount,
        quality: tick.quality,
        effectiveQuality: effectiveQuality != null ? Number(effectiveQuality) : null,
        difficulty: tick.difficulty,
        effectiveDifficulty,
        boardseshDifficulty: boardseshDifficulty == null ? null : Number(boardseshDifficulty),
        boardseshConfidence: toConfidenceTier(boardseshConfidence),
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
      }),
    );
  },

  /**
   * Per-board-type tick counts for a user, as ONE grouped aggregate.
   *
   * The home feed infers a default board when a user owns more than one wall and
   * hasn't picked an active board. That inference only needs to know which board
   * type the climber has logged the most on — not the ticks themselves — so this
   * returns `COUNT(*) GROUP BY board_type` in a single indexed round trip instead
   * of the caller fetching a full `userTicks` list per board (6-7 requests on the
   * home-load critical path). Public, like `userTicks`; counts aren't sensitive.
   */
  userTickCountsByBoard: async (
    _: unknown,
    { userId }: { userId: string },
  ): Promise<Array<{ boardType: string; count: number }>> => {
    if (!userId || typeof userId !== 'string' || userId.trim() === '') return [];

    const rows = await db
      .select({ boardType: dbSchema.boardseshTicks.boardType, tickCount: count() })
      .from(dbSchema.boardseshTicks)
      // Aurora's own duplicate ascents count once (#3535), so the inferred
      // default board matches what the logbook actually shows.
      .where(and(eq(dbSchema.boardseshTicks.userId, userId), notAuroraTwinDuplicate(dbSchema.boardseshTicks)))
      .groupBy(dbSchema.boardseshTicks.boardType);

    return rows.map((row) => ({ boardType: row.boardType, count: Number(row.tickCount) }));
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
    const sortBy = validatedInput.sortBy ?? 'recent';
    const sortOrder = validatedInput.sortOrder ?? 'desc';
    const secondarySortBy = validatedInput.secondarySortBy;
    const secondarySortOrder = validatedInput.secondarySortOrder ?? 'desc';

    // WHERE conditions shared with userGroupedAscentsFeed — one definition of
    // what every filter means (see buildAscentTickConditions at module scope).
    const tickConditions = buildAscentTickConditions(validatedInput, userId);

    // Base query with JOINs (shared by count and data queries)
    const baseQuery = db
      .select({
        tick: dbSchema.boardseshTicks,
        climbName: dbSchema.boardClimbs.name,
        climbDescription: dbSchema.boardClimbs.description,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        // Which sizes/sets the climb physically fits — drives renderBoard below.
        compatibleSizeIds: dbSchema.boardClimbs.compatibleSizeIds,
        requiredSetIds: dbSchema.boardClimbs.requiredSetIds,
        boardName: dbSchema.userBoards.name,
        boardIsPublic: dbSchema.userBoards.isPublic,
        boardIsUnlisted: dbSchema.userBoards.isUnlisted,
        // The board the tick was logged against, for renderBoard's first rung.
        boardLayoutId: dbSchema.userBoards.layoutId,
        boardSizeId: dbSchema.userBoards.sizeId,
        boardSetIds: dbSchema.userBoards.setIds,
        difficultyName: dbSchema.boardDifficultyGrades.boulderName,
        consensusDifficulty: consensusDifficultyExpr,
        consensusDifficultyName: consensusDifficultyNameExpr,
        boardseshDifficulty: boardseshDifficultyExpr,
        boardseshConfidence: boardseshConfidenceExpr,
        resolvedIsBenchmark: resolvedBenchmarkExpr,
        qualityAverage: dbSchema.boardClimbStats.qualityAverage,
        effectiveQuality: effectiveQualityExpr,
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
      // Synced-rating fallback for quality — see boardClimbRatingsJoinCondition.
      .leftJoin(dbSchema.boardClimbRatings, boardClimbRatingsJoinCondition)
      .leftJoin(consensusGradeTable, consensusGradeJoinCondition)
      // Boardsesh grade at the tick's OWN angle (aliases resolved above). LEFT JOIN
      // keeps ungraded ascents; grade fields come back NULL (safe fallback).
      .leftJoin(dbSchema.boardClimbGrades, BOARDSESH_GRADE_TICK_JOIN);

    // Full conditions including climb name filter (requires JOIN)
    const allConditions = [...tickConditions, ...buildAscentClimbConditions(validatedInput)];

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
      // Mirror hardest: effective grade (logged, else consensus) asc, so an
      // ungraded tick sorts by its consensus instead of floating out on a NULL
      // logged grade.
      resolvedPrimarySort = { field: 'effectiveGrade', direction: 'asc' };
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

    // Which of this page's CLIMBS carry a beta video of this user's — shared
    // helper (ownership mirrors the profile beta shelf), batched per page.
    // The climber's own boards decide which wall each ascent is drawn on, so
    // load them alongside (one query for the whole page).
    const [climbsWithBeta, ownerBoardsByUserId] = await Promise.all([
      fetchUserBetaClimbKeys(
        userId,
        Array.from(new Set(results.map(({ tick }) => tick.climbUuid))),
        results.map(({ tick }) => tick.uuid),
      ),
      fetchOwnerBoards([userId]),
    ]);
    const ownerBoards = ownerBoardsByUserId.get(userId) ?? [];

    // Map results to response format
    const items = results.map(
      ({
        tick,
        climbName,
        climbDescription,
        setterUsername,
        layoutId,
        frames,
        compatibleSizeIds,
        requiredSetIds,
        boardName,
        boardIsPublic,
        boardIsUnlisted,
        boardLayoutId,
        boardSizeId,
        boardSetIds,
        difficultyName,
        consensusDifficulty,
        consensusDifficultyName,
        boardseshDifficulty,
        boardseshConfidence,
        resolvedIsBenchmark,
        qualityAverage,
        effectiveQuality,
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
          // Deliberately NOT behind `canShowBoard`: this is wall geometry, not
          // board identity — it never reveals that a named board exists, and
          // gating it would send other viewers back to the wrong-size render.
          renderBoard: resolveRenderBoard({
            boardType: tick.boardType,
            climbLayoutId: layoutId,
            compatibleSizeIds,
            requiredSetIds,
            tickBoard: toTickBoardCandidate({
              boardType: tick.boardType,
              layoutId: boardLayoutId,
              sizeId: boardSizeId,
              setIds: boardSetIds,
            }),
            ownerBoards,
          }),
          angle: tick.angle,
          // is_mirror is nullable (default false, no NOT NULL); GraphQL exposes it
          // as Boolean!, so coerce a null to false here.
          isMirror: tick.isMirror ?? false,
          status: tick.status,
          attemptCount: tick.attemptCount,
          quality: tick.quality,
          effectiveQuality: effectiveQuality != null ? Number(effectiveQuality) : null,
          difficulty: tick.difficulty,
          difficultyName,
          consensusDifficulty:
            consensusDifficulty !== null && consensusDifficulty !== undefined ? Number(consensusDifficulty) : null,
          consensusDifficultyName,
          boardseshDifficulty: boardseshDifficulty == null ? null : Number(boardseshDifficulty),
          boardseshConfidence: toConfidenceTier(boardseshConfidence),
          isBenchmark: Boolean(resolvedIsBenchmark),
          isNoMatch: usesAuroraNoMatchDescription(tick.boardType) && isNoMatchClimb(climbDescription),
          qualityAverage: qualityAverage != null ? Number(qualityAverage) : null,
          comment: tick.comment || '',
          climbedAt: tick.climbedAt,
          frames,
          hasBetaVideo: climbsWithBeta.has(`${tick.boardType}:${tick.climbUuid}`),
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
    { userId, input }: { userId: string; input?: Record<string, unknown> },
    ctx?: ConnectionContext,
  ): Promise<{
    groups: unknown[];
    totalCount: number;
    hasMore: boolean;
  }> => {
    // Validate and set defaults. Accepts the full AscentFeedInput: filters are
    // shared with userAscentsFeed (one definition per filter), applied to BOTH
    // the group page and the tick fetch so group aggregates reflect exactly the
    // visible entries. Sort stays latest-activity — grouping is a date-view
    // concept; clients use the flat feed for grade-ordered views.
    const validatedInput = validateInput(AscentFeedInputSchema, input || {}, 'input');
    const limit = validatedInput.limit ?? 20;
    const offset = validatedInput.offset ?? 0;
    const tickConditions = buildAscentTickConditions(validatedInput, userId);
    const climbConditions = buildAscentClimbConditions(validatedInput);
    const groupFilterConditions = [...tickConditions, ...climbConditions];

    // boardsesh_ticks.climbed_at is `timestamp without time zone` storing the
    // climber's wall-clock time at the moment of the tick (the rest of the
    // codebase reads it back via `dayjs(...).utc(true)` to preserve that wall
    // clock — see ascents-feed.tsx). Group by the literal stored date so a
    // session ending at 11pm local doesn't bleed into the next day.
    const dayExpr = sql<string>`to_char(${dbSchema.boardseshTicks.climbedAt}, 'YYYY-MM-DD')`;

    // 1) Page of (climbUuid, day) keys, ordered by latest activity in that group.
    //    Bounds the SQL fetch to exactly the groups we'll return.
    // One filtered-groups base: joins (canonical climb for layout/name, stats +
    // consensus for grade/benchmark — 1:1 per tick, never multiplying group
    // rows) and WHERE applied ONCE, then both the page query and the count read
    // from it, so a join change can't drift between them.
    const filteredGroupsBase = db
      .select({
        climbUuid: dbSchema.boardseshTicks.climbUuid,
        day: dayExpr.as('day'),
        latestClimbedAt: sql<string>`max(${dbSchema.boardseshTicks.climbedAt})`.as('latest_climbed_at'),
      })
      .from(dbSchema.boardseshTicks)
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
      .leftJoin(consensusGradeTable, consensusGradeJoinCondition)
      .where(and(...groupFilterConditions))
      .groupBy(dbSchema.boardseshTicks.climbUuid, dayExpr)
      .as('filtered_groups');

    const pageGroups = await db
      .select({
        climbUuid: filteredGroupsBase.climbUuid,
        day: filteredGroupsBase.day,
        latestClimbedAt: filteredGroupsBase.latestClimbedAt,
      })
      .from(filteredGroupsBase)
      .orderBy(sql`${filteredGroupsBase.latestClimbedAt} desc`)
      .limit(limit)
      .offset(offset);

    // 2) True total group count — runs in parallel with the data fetch below.
    const totalCountPromise = db.select({ count: count() }).from(filteredGroupsBase);

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
        // Which sizes/sets the climb physically fits — drives renderBoard below.
        compatibleSizeIds: dbSchema.boardClimbs.compatibleSizeIds,
        requiredSetIds: dbSchema.boardClimbs.requiredSetIds,
        difficultyName: difficultyNameWithFallbackExpr,
        boardName: dbSchema.userBoards.name,
        boardIsPublic: dbSchema.userBoards.isPublic,
        boardIsUnlisted: dbSchema.userBoards.isUnlisted,
        // The board the tick was logged against, for renderBoard's first rung.
        boardLayoutId: dbSchema.userBoards.layoutId,
        boardSizeId: dbSchema.userBoards.sizeId,
        boardSetIds: dbSchema.userBoards.setIds,
        consensusDifficulty: consensusDifficultyExpr,
        consensusDifficultyName: consensusDifficultyNameExpr,
        boardseshDifficulty: boardseshDifficultyExpr,
        boardseshConfidence: boardseshConfidenceExpr,
        resolvedIsBenchmark: resolvedBenchmarkExpr,
        qualityAverage: dbSchema.boardClimbStats.qualityAverage,
        effectiveQuality: effectiveQualityExpr,
        day: dayExpr.as('day'),
      })
      .from(dbSchema.boardseshTicks)
      .leftJoin(dbSchema.userBoards, eq(dbSchema.boardseshTicks.boardId, dbSchema.userBoards.id))
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
      // Synced-rating fallback for quality — see boardClimbRatingsJoinCondition.
      .leftJoin(dbSchema.boardClimbRatings, boardClimbRatingsJoinCondition)
      .leftJoin(consensusGradeTable, consensusGradeJoinCondition)
      // Boardsesh grade at each tick's OWN angle (aliases resolved above). LEFT
      // JOIN keeps ungraded ticks; grade fields come back NULL (safe fallback).
      .leftJoin(dbSchema.boardClimbGrades, BOARDSESH_GRADE_TICK_JOIN)
      .where(
        and(
          ...groupFilterConditions,
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
      boardId: number | null;
      boardDisplayName: string | null;
      layoutId: number | null;
      renderBoard: RenderBoardConfig | null;
      angle: number;
      isMirror: boolean;
      status: string;
      attemptCount: number;
      quality: number | null;
      effectiveQuality: number | null;
      difficulty: number | null;
      difficultyName: string | null;
      consensusDifficulty: number | null;
      consensusDifficultyName: string | null;
      boardseshDifficulty: number | null;
      boardseshConfidence: string | null;
      qualityAverage: number | null;
      isBenchmark: boolean;
      isNoMatch: boolean;
      comment: string;
      climbedAt: string;
      frames: string | null;
      hasBetaVideo: boolean;
    };

    type GroupedAscent = {
      key: string;
      climbUuid: string;
      climbName: string;
      setterUsername: string | null;
      boardType: string;
      layoutId: number | null;
      renderBoard: RenderBoardConfig | null;
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

    // Beta ownership for the page's climbs — same helper + semantics as the
    // flat feed, so a group item and its flat-feed twin can never disagree. The
    // climber's boards decide which wall each ascent is drawn on; same deal.
    const [climbsWithBeta, ownerBoardsByUserId] = await Promise.all([
      fetchUserBetaClimbKeys(
        userId,
        climbUuidsInPage,
        tickRows.map(({ tick }) => tick.uuid),
      ),
      fetchOwnerBoards([userId]),
    ]);
    const ownerBoards = ownerBoardsByUserId.get(userId) ?? [];

    const groupMap = new Map<string, GroupedAscent>();

    for (const {
      tick,
      climbName,
      climbDescription,
      setterUsername,
      layoutId,
      frames,
      compatibleSizeIds,
      requiredSetIds,
      difficultyName,
      boardName,
      boardIsPublic,
      boardIsUnlisted,
      boardLayoutId,
      boardSizeId,
      boardSetIds,
      consensusDifficulty,
      consensusDifficultyName,
      boardseshDifficulty,
      boardseshConfidence,
      resolvedIsBenchmark,
      qualityAverage,
      effectiveQuality,
      day,
    } of tickRows) {
      const key = `${tick.climbUuid}-${day}`;
      // Skip ticks that fell inside the date window but belong to a different group.
      if (!pageKeySet.has(key)) continue;

      const isNoMatch = usesAuroraNoMatchDescription(tick.boardType) && isNoMatchClimb(climbDescription);

      const canShowBoard =
        tick.boardId != null && (ctx?.userId === userId || (boardIsPublic === true && boardIsUnlisted !== true));
      // Wall geometry, not board identity — see the flat feed for why this is
      // not behind `canShowBoard`.
      const renderBoard = resolveRenderBoard({
        boardType: tick.boardType,
        climbLayoutId: layoutId,
        compatibleSizeIds,
        requiredSetIds,
        tickBoard: toTickBoardCandidate({
          boardType: tick.boardType,
          layoutId: boardLayoutId,
          sizeId: boardSizeId,
          setIds: boardSetIds,
        }),
        ownerBoards,
      });
      const item: AscentItem = {
        uuid: tick.uuid,
        climbUuid: tick.climbUuid,
        climbName: climbName || 'Unknown Climb',
        setterUsername,
        boardType: tick.boardType,
        boardId: canShowBoard ? tick.boardId : null,
        boardDisplayName: canShowBoard ? boardName : null,
        layoutId,
        renderBoard,
        angle: tick.angle,
        isMirror: tick.isMirror ?? false,
        status: tick.status,
        attemptCount: tick.attemptCount,
        quality: tick.quality,
        effectiveQuality: effectiveQuality != null ? Number(effectiveQuality) : null,
        difficulty: tick.difficulty,
        difficultyName,
        consensusDifficulty:
          consensusDifficulty !== null && consensusDifficulty !== undefined ? Number(consensusDifficulty) : null,
        consensusDifficultyName,
        boardseshDifficulty: boardseshDifficulty == null ? null : Number(boardseshDifficulty),
        boardseshConfidence: toConfidenceTier(boardseshConfidence),
        qualityAverage: qualityAverage != null ? Number(qualityAverage) : null,
        isBenchmark: Boolean(resolvedIsBenchmark),
        isNoMatch,
        comment: tick.comment || '',
        climbedAt: tick.climbedAt,
        frames,
        hasBetaVideo: climbsWithBeta.has(`${tick.boardType}:${tick.climbUuid}`),
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
          // A group is one climb on one day, so its ticks share a layout — but
          // not necessarily a board: climb it on two walls in a day and they
          // resolve differently. The header takes the first tick's board (ticks
          // are ordered climbed_at DESC, so that's the latest one). Consumers
          // that care read the per-item `renderBoard` instead — mobile's grouped
          // logbook already does, since it re-buckets from `group.items`.
          renderBoard,
          angle: tick.angle,
          isMirror: tick.isMirror ?? false,
          frames,
          difficultyName,
          isBenchmark: Boolean(resolvedIsBenchmark),
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

      // bestQuality is the highest EFFECTIVE quality in the group, so a
      // Kilter-pulled tick whose own quality is null still contributes its
      // synced star rating (item.effectiveQuality) to the group header.
      if (item.effectiveQuality !== null) {
        if (group.bestQuality === null || item.effectiveQuality > group.bestQuality) {
          group.bestQuality = item.effectiveQuality;
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

      // Run three queries for this board type:
      // - gradeResults: counts per (layout, effective difficulty) for the chart
      // - distinctByLayout: per-layout distinct climb count (correct even when one
      //   climb appears across multiple grade buckets — e.g. logged at multiple
      //   angles whose consensus differs)
      // - distinctClimbs: global distinct climbs for `totalDistinctClimbs`
      //
      // All three run inside ONE withSerialPlan transaction per board type. This
      // resolver fans out over every SUPPORTED_BOARDS entry, so it was issuing up
      // to 21 concurrent aggregates over boardsesh_ticks ⋈ board_climbs ⋈
      // board_climb_stats — the highest concurrent DSM demand in the codebase, and
      // enough for a single profile load to exhaust /dev/shm (#4105). Sharing one
      // transaction also caps concurrency at one connection per board type rather
      // than three, which matters against a `max: 10` pool. Queries on a single
      // postgres.js connection run sequentially, so this trades a little latency
      // on the You page for not falling over.
      const [gradeResults, distinctByLayout, distinctClimbs] = await withSerialPlan(db, (tx) =>
        Promise.all([
          tx
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

          tx
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

          tx
            .selectDistinct({ climbUuid: dbSchema.boardseshTicks.climbUuid })
            .from(dbSchema.boardseshTicks)
            .where(baseConditions),
        ]),
      );

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
