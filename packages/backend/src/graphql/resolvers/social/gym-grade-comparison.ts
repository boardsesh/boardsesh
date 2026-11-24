import { and, eq, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import { rowsFromResult } from '@boardsesh/db/client';
import { gymBoardGradeCollections, userBoards } from '@boardsesh/db/schema';
import type { ConnectionContext, GymGradeCollectionPage, GymGradeComparison } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { isValidBoardName } from '../../../db/queries/util/table-select';
import { applyRateLimit, validateInput } from '../shared/helpers';
import {
  assertInventoryWorkBounded,
  countRawInventoryRows,
  currentInventoryVariantsSql,
  currentReferenceDifficultySql,
  currentReferenceGradeJoins,
  gradeCollectionAccessSql,
  GYM_INVENTORY_MAX_BOARDS,
  GYM_INVENTORY_MAX_REFS,
  inventoryBoardSummary,
  inventoryScopeTooLarge,
  ledInventoryVariantsSql,
  readInventoryBoards,
  validCollectionHeader,
  type GradeCollectionHeader,
} from './gym-inventory';
import { chooseSprayObservationBindings, observeSprayInventory } from './gym-spray-exposure';
import {
  authorizedReportingBoardCondition,
  reportingActivityInWindowSql,
  reportingActivitySql,
  reportingBoardNotFound,
  REPORTING_AUTHOR_OVERHANG_HOURS,
  requireReportingUser,
  withGymReportingScope,
  type GymReportingScope,
  type GymReportingTransaction,
} from './gym-reporting';
import { requireGymEditAccess } from './gyms';
import { isSharedConfigFeedBoard } from '../board-presence/shared';
import { logger } from '../../../utils/logger';
import { escapeLikePattern } from '../../../utils/like-pattern';

const PICKER_PAGE = 20;
const MAX_CANDIDATE_TICKS = 100_000;
const compareOptions = { maxBoards: GYM_INVENTORY_MAX_BOARDS, operation: 'gym-grade-comparison', readsPerMinute: 20 };
const comparisonTarget = { gymUuid: z.string().uuid(), boardUuid: z.string().uuid() };
const pickerInput = z.object({
  ...comparisonTarget,
  search: z.string().trim().max(100).nullish(),
  cursor: z
    .string()
    .regex(/^[1-9][0-9]{0,17}$/)
    .nullish(),
});
const selectionInput = z.object({
  ...comparisonTarget,
  playlistUuid: z.string().trim().min(1).max(128).nullish(),
});

function boundedSectionError(error: unknown): never {
  const failure = error as { code?: string; cause?: { code?: string } } | null;
  const code = failure?.code ?? failure?.cause?.code;
  if (code === '57014' || code === '55P03' || code === '40001') {
    throw new GraphQLError('Grade comparison is temporarily unavailable', {
      extensions: { code: 'TEMPORARILY_UNAVAILABLE' },
    });
  }
  throw error;
}

async function assertSendsBounded(tx: GymReportingTransaction, scope: GymReportingScope): Promise<void> {
  if (scope.boardIds.length === 0) return;
  const padding = sql`make_interval(hours => ${REPORTING_AUTHOR_OVERHANG_HOURS}::int)`;
  const [row] = rowsFromResult<{ count: number }>(
    await tx.execute(sql`
    SELECT count(*)::int AS count FROM (
      SELECT 1 FROM boardsesh_ticks
      WHERE board_id IN (${sql.join(
        scope.boardIds.map((id) => sql`${id}`),
        sql`, `,
      )})
        AND climbed_at >= (${scope.current.startAt}::timestamptz AT TIME ZONE 'UTC') - ${padding}
        AND climbed_at < (${scope.asOf}::timestamptz AT TIME ZONE 'UTC') + ${padding}
      LIMIT ${MAX_CANDIDATE_TICKS + 1}
    ) bounded
  `),
  );
  if (row.count > MAX_CANDIDATE_TICKS) throw inventoryScopeTooLarge();
}

type ComparisonCounts = {
  availableCount: number;
  sendCount: number;
  grades: GymGradeComparison['grades'];
  boardCounts: { boardId: number; count: number }[];
};

async function readGradeComparison(tx: GymReportingTransaction, scope: GymReportingScope): Promise<GymGradeComparison> {
  const boards = await readInventoryBoards(tx, scope);
  await assertInventoryWorkBounded(tx, boards);
  const inventory = currentInventoryVariantsSql(boards);
  const offeringBoards = rowsFromResult<{ id: number }>(
    await tx.execute(sql`
    SELECT DISTINCT board_id::double precision AS id FROM (${inventory}) scoped_offerings
  `),
  );
  const candidateIds = new Set(offeringBoards.map(({ id }) => id));
  const activityScope = {
    ...scope,
    boardIds: scope.boardIds.filter((id) => candidateIds.has(id)),
    activityBoards: scope.activityBoards.filter(({ id }) => candidateIds.has(id)),
  };
  await assertSendsBounded(tx, activityScope);
  const [counts] = rowsFromResult<ComparisonCounts>(
    await tx.execute(sql`
    WITH inventory AS MATERIALIZED (${inventory}),
    activity AS (
      ${reportingActivitySql(activityScope, { start: scope.current.startAt, end: scope.asOf, sendsOnly: true })}
    ),
    physical_variants AS (
      SELECT DISTINCT physical_board_uuid, board_type, climb_uuid, angle FROM inventory
    ),
    supply_counts AS (
      SELECT variant.board_type, ${currentReferenceDifficultySql()}::int AS difficulty,
        count(*)::int AS available_count
      FROM physical_variants variant ${currentReferenceGradeJoins()}
      GROUP BY 1, 2
    ),
    send_counts AS (
      SELECT variant.board_type, ${currentReferenceDifficultySql()}::int AS difficulty,
        count(*)::int AS send_count
      FROM activity
      JOIN inventory variant ON variant.board_id = activity.board_id
        AND variant.board_type = activity.board_type AND variant.climb_uuid = activity.climb_uuid
        AND variant.angle = activity.angle
      ${currentReferenceGradeJoins()}
      WHERE activity.is_mirror IS FALSE AND activity.source = 'tick' AND ${reportingActivityInWindowSql(scope.current)}
      GROUP BY 1, 2
    ),
    grades AS (
      SELECT supply_counts.board_type AS "boardType", supply_counts.difficulty AS "difficultyId",
        supply_counts.available_count AS "availableCount", coalesce(send_counts.send_count, 0) AS "sendCount"
      FROM supply_counts
      LEFT JOIN send_counts ON send_counts.board_type = supply_counts.board_type
        AND send_counts.difficulty IS NOT DISTINCT FROM supply_counts.difficulty
    ),
    board_counts AS (
      SELECT board_id AS "boardId", count(*)::int AS count FROM inventory GROUP BY board_id
    )
    SELECT coalesce((SELECT sum("availableCount") FROM grades), 0)::int AS "availableCount",
      coalesce((SELECT sum("sendCount") FROM grades), 0)::int AS "sendCount",
      coalesce((SELECT json_agg(grades ORDER BY "boardType", "difficultyId") FROM grades), '[]'::json) AS grades,
      coalesce((SELECT json_agg(board_counts) FROM board_counts), '[]'::json) AS "boardCounts"
  `),
  );
  const countByBoard = new Map(counts.boardCounts.map(({ boardId, count }) => [boardId, count]));
  return {
    gymUuid: scope.gym.uuid,
    asOf: scope.asOf,
    startAt: scope.current.startAt,
    timeZone: scope.timeZone,
    availableCount: counts.availableCount,
    sendCount: counts.sendCount,
    grades: counts.grades,
    boards: boards.map((board) => inventoryBoardSummary(board, countByBoard.get(board.id) ?? 0)),
  };
}

async function gradeComparison(ctx: ConnectionContext, input: unknown): Promise<GymGradeComparison> {
  requireReportingUser(ctx);
  await applyRateLimit(ctx, compareOptions.readsPerMinute, compareOptions.operation);
  const options = { ...compareOptions, chargeRate: false };
  try {
    const { scope, bindings } = await withGymReportingScope(
      input,
      ctx,
      async (tx, scope) => {
        const boards = await readInventoryBoards(tx, scope);
        const candidates = boards.flatMap((board) => (board.readySprayBinding ? [board.readySprayBinding] : []));
        return { scope, bindings: await chooseSprayObservationBindings(tx, candidates) };
      },
      options,
    );
    await observeSprayInventory(scope, bindings);
  } catch {
    // A measurement failure must not hide current inventory. The next snapshot
    // repeats input validation, staff permissions and board selection.
    logger.debug('Unable to prepare spray exposure observations for grade comparison');
  }
  try {
    return await withGymReportingScope(input, ctx, readGradeComparison, options);
  } catch (error) {
    return boundedSectionError(error);
  }
}

async function selectorBoard(
  tx: GymReportingTransaction,
  gymUuid: string,
  boardUuid: string,
  viewerId: string,
  lock: boolean,
) {
  const gym = await requireGymEditAccess(gymUuid, viewerId, tx);
  const read = tx
    .select({
      id: userBoards.id,
      uuid: userBoards.uuid,
      slug: userBoards.slug,
      ownerId: userBoards.ownerId,
      boardType: userBoards.boardType,
      layoutId: userBoards.layoutId,
      sizeId: userBoards.sizeId,
      setIds: userBoards.setIds,
      angle: userBoards.angle,
      isAngleAdjustable: userBoards.isAngleAdjustable,
    })
    .from(userBoards)
    .where(and(eq(userBoards.uuid, boardUuid), authorizedReportingBoardCondition(gym.id, viewerId)));
  const [board] = lock ? await read.for('no key update', { of: userBoards }) : await read;
  if (!board || board.boardType === 'spray' || !isValidBoardName(board.boardType) || isSharedConfigFeedBoard(board)) {
    throw reportingBoardNotFound();
  }
  return board;
}

export const gymGradeComparisonQueries = {
  gymGradeComparison: (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) =>
    gradeComparison(ctx, input),
  gymGradeCollectionOptions: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<GymGradeCollectionPage> => {
    const viewerId = requireReportingUser(ctx);
    await applyRateLimit(ctx, 30, 'gym-grade-collection-options');
    const request = validateInput(pickerInput, input, 'input');
    try {
      return await db.transaction(
        async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
          const board = await selectorBoard(tx, request.gymUuid, request.boardUuid, viewerId, false);
          const rows = rowsFromResult<GradeCollectionHeader>(
            await tx.execute(sql`
          SELECT playlists.id::text, playlists.uuid, playlists.name
          FROM playlists WHERE playlists.board_type = ${board.boardType}
            AND (playlists.layout_id = ${board.layoutId} OR playlists.layout_id IS NULL)
            AND ${gradeCollectionAccessSql(viewerId)}
            ${request.cursor ? sql`AND playlists.id > ${request.cursor}::bigint` : sql``}
            ${request.search ? sql`AND playlists.name ILIKE ${'%' + escapeLikePattern(request.search) + '%'}` : sql``}
          ORDER BY playlists.id LIMIT ${PICKER_PAGE + 1}
        `),
          );
          const choices = rows.slice(0, PICKER_PAGE);
          return {
            collections: choices.map(({ uuid, name }) => ({ uuid, name })),
            nextCursor: rows.length > PICKER_PAGE ? choices.at(-1)!.id : null,
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    } catch (error) {
      return boundedSectionError(error);
    }
  },
};

export const gymGradeComparisonMutations = {
  setGymGradeCollection: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    const viewerId = requireReportingUser(ctx);
    await applyRateLimit(ctx, 10, 'gym-grade-collection-save');
    const request = validateInput(selectionInput, input, 'input');
    try {
      return await db.transaction(
        async (tx) => {
          await tx.execute(
            sql`SELECT set_config('statement_timeout', '2000ms', true), set_config('lock_timeout', '100ms', true)`,
          );
          const board = await selectorBoard(tx, request.gymUuid, request.boardUuid, viewerId, true);
          if (request.playlistUuid == null) {
            await tx.delete(gymBoardGradeCollections).where(eq(gymBoardGradeCollections.boardId, board.id));
            return true;
          }
          const [collection] = rowsFromResult<GradeCollectionHeader>(
            await tx.execute(sql`
          SELECT playlists.id::text, playlists.uuid, playlists.name,
            playlists.board_type AS "boardType", playlists.layout_id AS "layoutId"
          FROM playlists WHERE playlists.uuid = ${request.playlistUuid} AND ${gradeCollectionAccessSql(viewerId)}
          LIMIT 1
        `),
          );
          const invalid = () =>
            new GraphQLError('Comparison collection is unavailable', {
              extensions: { code: 'COLLECTION_UNAVAILABLE' },
            });
          if (!collection || !validCollectionHeader(collection, board)) throw invalid();
          const rawCount = await countRawInventoryRows(
            tx,
            sql`SELECT 1 FROM playlist_climbs WHERE playlist_id = ${collection.id}::bigint`,
          );
          if (rawCount > GYM_INVENTORY_MAX_REFS) throw inventoryScopeTooLarge();
          if (rawCount > 0) {
            const fitting = rowsFromResult(
              await tx.execute(sql`
            SELECT 1 FROM (${ledInventoryVariantsSql(board, collection)}) compatible LIMIT 1
          `),
            );
            if (fitting.length === 0) throw invalid();
          }
          const playlistId = BigInt(collection.id);
          await tx
            .insert(gymBoardGradeCollections)
            .values({ boardId: board.id, playlistId })
            .onConflictDoUpdate({ target: gymBoardGradeCollections.boardId, set: { playlistId } });
          return true;
        },
        { isolationLevel: 'repeatable read' },
      );
    } catch (error) {
      return boundedSectionError(error);
    }
  },
};
