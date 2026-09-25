import { eq, and, count, desc, inArray, sql, type SQL } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { sprayReferenceVisibilityCondition } from '@boardsesh/db/queries';
import { validateInput } from '../../shared/helpers';
import { isSprayBoardType, sprayClimbUuidIsReadable } from '../../climbs/spray-read-access';
import { GetClimbProposalsInputSchema, BrowseProposalsInputSchema } from '../../../../validation/schemas';
import { resolveCommunitySetting } from '../community-settings';
import { batchEnrichProposals } from './enrichment';
import { analyzeGradeOutlier } from './grade-analysis';

export const socialProposalQueries = {
  climbProposals: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    const validated = validateInput(GetClimbProposalsInputSchema, input, 'input');
    const { climbUuid, boardType, angle, type, status, limit: rawLimit, offset: rawOffset } = validated;
    const limitVal = rawLimit ?? 20;
    const offsetVal = rawOffset ?? 0;
    const authenticatedUserId = ctx.isAuthenticated ? ctx.userId : null;

    // A proposal names its climb and carries the proposer's reason. The climb is
    // one uuid away and never joined, so this is the reference form of the wall
    // rule — and an unreadable wall gets the EMPTY PAGE, not an error, so the
    // shape is not an oracle for which climbs are on a private wall.
    //
    // Short-circuited on the board type, which this resolver has in hand, so the
    // eight catalogue boards pay nothing — not even the round trip.
    // `comments(input)` cannot do the same: it is keyed on an entity, not a board.
    if (isSprayBoardType(boardType) && !(await sprayClimbUuidIsReadable(climbUuid, authenticatedUserId))) {
      return { proposals: [], totalCount: 0, hasMore: false };
    }

    const conditions = [
      eq(dbSchema.climbProposals.climbUuid, climbUuid),
      eq(dbSchema.climbProposals.boardType, boardType),
    ];
    if (angle != null) conditions.push(eq(dbSchema.climbProposals.angle, angle));
    if (type) conditions.push(eq(dbSchema.climbProposals.type, type));
    if (status) conditions.push(eq(dbSchema.climbProposals.status, status));

    const proposals = await db
      .select()
      .from(dbSchema.climbProposals)
      .where(and(...conditions))
      .orderBy(desc(dbSchema.climbProposals.createdAt))
      .limit(limitVal)
      .offset(offsetVal);

    const [totalResult] = await db
      .select({ count: count() })
      .from(dbSchema.climbProposals)
      .where(and(...conditions));

    const totalCount = Number(totalResult?.count || 0);
    const enriched = await batchEnrichProposals(proposals, authenticatedUserId);

    return {
      proposals: enriched,
      totalCount,
      hasMore: offsetVal + limitVal < totalCount,
    };
  },

  browseProposals: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    const validated = validateInput(BrowseProposalsInputSchema, input, 'input');
    const { type, types, status, limit: rawLimit, offset: rawOffset } = validated;
    const limitVal = rawLimit ?? 20;
    const offsetVal = rawOffset ?? 0;
    const authenticatedUserId = ctx.isAuthenticated ? ctx.userId : null;

    // Resolve boardUuid to boardType if provided
    let boardTypeFilter: string | null = validated.boardType ?? null;
    if (!boardTypeFilter && validated.boardUuid) {
      const board = await db
        .select({ boardType: dbSchema.userBoards.boardType })
        .from(dbSchema.userBoards)
        .where(eq(dbSchema.userBoards.uuid, validated.boardUuid))
        .limit(1)
        .then((rows) => rows[0]);

      if (board) {
        boardTypeFilter = board.boardType;
      }
    }

    // Carried in the WHERE that also carries the LIMIT/OFFSET, and repeated on the
    // COUNT below, so a private wall's proposal neither shortens a page nor
    // inflates a total. `browseProposals` is unauthenticated, so the viewer is
    // null for an anonymous caller — never a hopeful value.
    const conditions: SQL[] = [
      sprayReferenceVisibilityCondition(
        { boardType: dbSchema.climbProposals.boardType, climbUuid: dbSchema.climbProposals.climbUuid },
        authenticatedUserId,
      ),
    ];
    if (boardTypeFilter) conditions.push(eq(dbSchema.climbProposals.boardType, boardTypeFilter));
    if (type) conditions.push(eq(dbSchema.climbProposals.type, type));
    // `types` is the multi-select form of `type`; both narrow, so a caller that
    // sends the pair gets the intersection.
    if (types?.length) conditions.push(inArray(dbSchema.climbProposals.type, types));
    if (status) conditions.push(eq(dbSchema.climbProposals.status, status));

    const whereClause = and(...conditions);

    // Sort with open proposals first, then by creation date
    const proposals = await db
      .select()
      .from(dbSchema.climbProposals)
      .where(whereClause)
      .orderBy(
        sql`CASE WHEN ${dbSchema.climbProposals.status} = 'open' THEN 0 ELSE 1 END`,
        desc(dbSchema.climbProposals.createdAt),
      )
      .limit(limitVal)
      .offset(offsetVal);

    const [totalResult] = await db.select({ count: count() }).from(dbSchema.climbProposals).where(whereClause);

    const totalCount = Number(totalResult?.count || 0);
    const enriched = await batchEnrichProposals(proposals, authenticatedUserId);

    return {
      proposals: enriched,
      totalCount,
      hasMore: offsetVal + limitVal < totalCount,
    };
  },

  climbCommunityStatus: async (
    _: unknown,
    { climbUuid, boardType, angle }: { climbUuid: string; boardType: string; angle: number },
    ctx: ConnectionContext,
  ) => {
    // Get community status
    const [status] = await db
      .select()
      .from(dbSchema.climbCommunityStatus)
      .where(
        and(
          eq(dbSchema.climbCommunityStatus.climbUuid, climbUuid),
          eq(dbSchema.climbCommunityStatus.boardType, boardType),
          eq(dbSchema.climbCommunityStatus.angle, angle),
        ),
      )
      .limit(1);

    // Get classic status
    const [classicStatus] = await db
      .select()
      .from(dbSchema.climbClassicStatus)
      .where(
        and(eq(dbSchema.climbClassicStatus.climbUuid, climbUuid), eq(dbSchema.climbClassicStatus.boardType, boardType)),
      )
      .limit(1);

    // Check if frozen
    const frozenSetting = await resolveCommunitySetting('climb_frozen', climbUuid, angle, boardType);
    const isFrozen = frozenSetting === 'true';

    let freezeReason: string | undefined;
    if (isFrozen) {
      freezeReason = await resolveCommunitySetting('climb_freeze_reason', climbUuid, angle, boardType);
      if (freezeReason === '0') freezeReason = undefined;
    }

    // Count open proposals
    const [openCount] = await db
      .select({ count: count() })
      .from(dbSchema.climbProposals)
      .where(
        and(
          eq(dbSchema.climbProposals.climbUuid, climbUuid),
          eq(dbSchema.climbProposals.boardType, boardType),
          eq(dbSchema.climbProposals.status, 'open'),
        ),
      );

    // Run outlier analysis
    const outlierAnalysis = await analyzeGradeOutlier(climbUuid, boardType, angle, ctx?.userId);

    return {
      climbUuid,
      boardType,
      angle,
      communityGrade: status?.communityGrade || null,
      isBenchmark: status?.isBenchmark || false,
      isClassic: classicStatus?.isClassic || false,
      isFrozen,
      freezeReason: freezeReason || null,
      openProposalCount: Number(openCount?.count || 0),
      outlierAnalysis: outlierAnalysis || null,
      updatedAt: status?.updatedAt?.toISOString() || null,
    };
  },

  bulkClimbCommunityStatus: async (
    _: unknown,
    { climbUuids, boardType, angle }: { climbUuids: string[]; boardType: string; angle: number },
    _ctx: ConnectionContext,
  ) => {
    if (climbUuids.length === 0) return [];

    const statuses = await db
      .select()
      .from(dbSchema.climbCommunityStatus)
      .where(
        and(
          inArray(dbSchema.climbCommunityStatus.climbUuid, climbUuids),
          eq(dbSchema.climbCommunityStatus.boardType, boardType),
          eq(dbSchema.climbCommunityStatus.angle, angle),
        ),
      );

    const classicStatuses = await db
      .select()
      .from(dbSchema.climbClassicStatus)
      .where(
        and(
          inArray(dbSchema.climbClassicStatus.climbUuid, climbUuids),
          eq(dbSchema.climbClassicStatus.boardType, boardType),
        ),
      );

    const statusMap = new Map(statuses.map((s) => [s.climbUuid, s]));
    const classicMap = new Map(classicStatuses.map((s) => [s.climbUuid, s]));

    return climbUuids.map((uuid) => {
      const status = statusMap.get(uuid);
      const classicStatus = classicMap.get(uuid);
      return {
        climbUuid: uuid,
        boardType,
        angle,
        communityGrade: status?.communityGrade || null,
        isBenchmark: status?.isBenchmark || false,
        isClassic: classicStatus?.isClassic || false,
        isFrozen: false,
        freezeReason: null,
        openProposalCount: 0,
        outlierAnalysis: null,
        updatedAt: status?.updatedAt?.toISOString() || null,
      };
    });
  },

  climbClassicStatus: async (
    _: unknown,
    { climbUuid, boardType }: { climbUuid: string; boardType: string },
    _ctx: ConnectionContext,
  ) => {
    const [status] = await db
      .select()
      .from(dbSchema.climbClassicStatus)
      .where(
        and(eq(dbSchema.climbClassicStatus.climbUuid, climbUuid), eq(dbSchema.climbClassicStatus.boardType, boardType)),
      )
      .limit(1);

    return {
      climbUuid,
      boardType,
      isClassic: status?.isClassic || false,
      updatedAt: status?.updatedAt?.toISOString() || null,
    };
  },
};
