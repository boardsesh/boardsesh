import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import { rowsFromResult } from '@boardsesh/db/client';
import { boardGymListedCondition, resourceAccessCondition } from '@boardsesh/db/queries';
import type {
  ConnectionContext,
  GymClimbRankingMode,
  GymClimbRankingRow,
  GymClimbRankingStatus,
  GymClimbRankings,
  GymClimbRankingTarget,
} from '@boardsesh/shared-schema';
import { GymStatsInputSchema, UUIDSchema } from '../../../validation/schemas';
import { applyRateLimit, validateInput } from '../shared/helpers';
import {
  activeSprayInventorySql,
  assertInventoryWorkBounded,
  currentReferenceDifficultySql,
  currentReferenceGradeJoins,
  GYM_INVENTORY_MAX_BOARDS,
  inventoryScopeTooLarge,
  readInventoryBoards,
  sprayInventoryClimbCondition,
  type InventoryBoard,
} from './gym-inventory';
import { ledRankingVariantCondition, validRankingOrientation } from './gym-ranking-variants';
import {
  readReportingBoundaries,
  reportingBoardNotFound,
  REPORTING_AUTHOR_OVERHANG_HOURS,
  requireReportingUser,
  withGymReportingScope,
  type GymReportingScope,
  type GymReportingTransaction,
} from './gym-reporting';
import {
  assertSprayExposureBounded,
  chooseSprayObservationBindings,
  observeSprayInventory,
  sprayExposureIntervalsSql,
} from './gym-spray-exposure';
import {
  commentRankScores,
  gradeScaleSql,
  quietRankScores,
  rankingVoteActivity,
  tickRankScores,
} from './gym-ranking-scores';

const pageSize = 20;
const rankingLimit = 200;
const maxCandidateTicks = 100_000;
const maxCandidateComments = 4_096;
const receiptMs = 5 * 60_000;
const options = { maxBoards: GYM_INVENTORY_MAX_BOARDS, operation: 'gym-climb-rankings', readsPerMinute: 20 } as const;
const modes = ['MOST_SENT', 'TOP_RATED', 'MOST_DISCUSSED', 'GRADE_FEEDBACK', 'QUIET_CLIMBS'] as const;
const rankingInput = GymStatsInputSchema.extend({ mode: z.enum(modes), cursor: z.string().max(512).nullish() });
const targetInput = GymStatsInputSchema.extend({
  logicalBoardUuid: UUIDSchema,
  climbUuid: z.string().min(1).max(128),
  angle: z.number().int().min(-5).max(90),
  isMirror: z.boolean(),
});
const continuationInput = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  page: z
    .number()
    .int()
    .min(1)
    .max(rankingLimit / pageSize - 1),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
type Continuation = z.infer<typeof continuationInput>;

function continuation(cursor: string): Continuation | null {
  try {
    const result = continuationInput.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (!result.success) return null;
    const { asOf } = result.data;
    const parsed = new Date(asOf);
    // Reject a rollover date before constructing the PostgreSQL timestamp.
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 23) === asOf.slice(0, 23)
      ? result.data
      : null;
  } catch {
    return null;
  }
}

function emptyReport(
  mode: GymClimbRankingMode,
  status: GymClimbRankingStatus,
  scope?: GymReportingScope,
  quietAvailable = false,
): GymClimbRankings {
  return {
    status,
    mode,
    quietAvailable,
    rows: [],
    nextCursor: null,
    truncated: false,
    startAt: scope?.current.startAt ?? null,
    asOf: scope?.asOf ?? null,
    timeZone: scope?.timeZone ?? null,
    timeZoneConfigured: scope?.timeZoneConfigured ?? false,
  };
}

async function assertRawCandidates(tx: GymReportingTransaction, source: SQL, maximum: number) {
  const [result] = rowsFromResult<{ count: number }>(
    await tx.execute(sql`
    SELECT count(*)::int AS count FROM (${source} LIMIT ${maximum + 1}) bounded
  `),
  );
  if (result.count > maximum) throw inventoryScopeTooLarge();
}

function scopedBoardIds(scope: GymReportingScope): SQL {
  return sql`(${
    scope.boardIds.length
      ? sql.join(
          scope.boardIds.map((id) => sql`${id}`),
          sql`, `,
        )
      : sql`NULL::bigint`
  })`;
}

export function rankingTickCandidatesSql(scope: GymReportingScope, start: string): SQL {
  const padding = sql`make_interval(hours => ${REPORTING_AUTHOR_OVERHANG_HOURS}::int)`;
  return sql`
    SELECT 1 FROM boardsesh_ticks WHERE board_id IN ${scopedBoardIds(scope)}
      AND climbed_at >= (${start}::timestamptz AT TIME ZONE 'UTC') - ${padding}
      AND climbed_at < (${scope.asOf}::timestamptz AT TIME ZONE 'UTC') + ${padding}
  `;
}

export function rankingCommentCandidatesSql(scope: GymReportingScope, columns: SQL, enforceVenue: boolean): SQL {
  return sql`
    SELECT ${columns} FROM gym_climb_comment_attributions
    WHERE logical_board_id IN ${scopedBoardIds(scope)}
      AND comment_created_at >= (${scope.current.startAt}::timestamptz AT TIME ZONE 'UTC')
      AND comment_created_at < (${scope.asOf}::timestamptz AT TIME ZONE 'UTC')
      ${
        enforceVenue
          ? sql`AND gym_id IN (${sql.join(
              scope.canonicalGymIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``
      }
  `;
}

function configurationsSql(scope: GymReportingScope): SQL {
  return sql`SELECT boards.id AS board_id, boards.uuid AS board_uuid, boards.slug, boards.layout_id, boards.size_id,
      boards.set_ids, scoped.name,
      boards.is_public AND NOT boards.is_unlisted
        AND ${resourceAccessCondition('board', sql`boards.uuid`, null, { allowUnlistedLink: false })}
        AND ${boardGymListedCondition(sql`boards.gym_id`)} AS shareable,
      scoped.physical_board_uuid
    FROM user_boards boards JOIN (${
      scope.activityBoards.length
        ? sql`VALUES ${sql.join(
            scope.activityBoards.map(
              (board) => sql`(
        ${board.id}::bigint, ${board.physicalBoardUuid}::text,
        ${scope.boards.find(({ uuid }) => uuid === board.physicalBoardUuid)?.name ?? board.name}::text
      )`,
            ),
            sql`, `,
          )}`
        : sql`SELECT NULL::bigint, NULL::text, NULL::text WHERE false`
    }) scoped(board_id, physical_board_uuid, name)
      ON boards.id = scoped.board_id`;
}

function eligibleVariantSql(boards: readonly InventoryBoard[]): SQL {
  const led = boards
    .filter(({ boardType }) => boardType !== 'spray')
    .map(
      (board) => sql`
    (activity.board_id = ${board.id} AND ${ledRankingVariantCondition(board, sql`activity.angle`, sql`activity.is_mirror`)})
  `,
    );
  return sql`
    JOIN board_climbs ON board_climbs.board_type = activity.board_type AND board_climbs.uuid = activity.climb_uuid
    WHERE (
      (activity.board_type = 'spray' AND activity.is_mirror IS FALSE AND EXISTS (
        SELECT 1 FROM inventory WHERE inventory.board_id = activity.board_id AND inventory.climb_uuid = activity.climb_uuid
          AND inventory.angle = activity.angle
      ))
      ${led.length ? sql`OR ${sql.join(led, sql` OR `)}` : sql``}
    )
  `;
}

const scoreOrder: Record<GymClimbRankingMode, SQL> = {
  MOST_SENT: sql`variant."sendCount" DESC`,
  TOP_RATED: sql`variant."qualityMean" DESC, variant."voterCount" DESC`,
  MOST_DISCUSSED: sql`variant."commentCount" DESC`,
  GRADE_FEEDBACK: sql`abs(variant."gradeDelta") DESC, variant."voterCount" DESC`,
  QUIET_CLIMBS: sql`variant."sendsPerDay" ASC, coalesce(variant."lastSendEndAt", variant."lastSendAt") ASC NULLS FIRST`,
};

function targetProjection(): SQL {
  return sql`json_build_object(
    'logicalBoardUuid', configs.board_uuid, 'boardSlug', configs.slug, 'boardType', variant.board_type,
    'layoutId', configs.layout_id, 'sizeId', configs.size_id, 'setIds', configs.set_ids, 'climbUuid', variant.climb_uuid,
    'name', coalesce(board_climbs.name, ''), 'angle', variant.angle, 'isMirror', variant.is_mirror,
    'referenceDifficulty', ${currentReferenceDifficultySql()}::int, 'shareable', configs.shareable
  )`;
}

/** The scoped data statement shared by the resolver and its query-plan fixture. */
export async function prepareRankingRowsStatement(
  tx: GymReportingTransaction,
  scope: GymReportingScope,
  mode: GymClimbRankingMode,
  boards: InventoryBoard[],
): Promise<SQL | null> {
  const bindings = boards.flatMap(({ readySprayBinding }) => (readySprayBinding ? [readySprayBinding] : []));
  const inventory = activeSprayInventorySql(bindings);
  const eligibility = eligibleVariantSql(boards);
  let scores: SQL;
  if (mode === 'QUIET_CLIMBS') {
    if (!bindings.length) return null;
    const sprayBoardIds = new Set(bindings.map(({ boardId }) => boardId));
    const sprayScope = {
      ...scope,
      boardIds: scope.boardIds.filter((id) => sprayBoardIds.has(id)),
      activityBoards: scope.activityBoards.filter(({ id }) => sprayBoardIds.has(id)),
    };
    await assertSprayExposureBounded(tx, sprayScope, bindings);
    const intervals = sprayExposureIntervalsSql(sprayScope, bindings);
    const [first] = rowsFromResult<{ start: string | null }>(
      await tx.execute(sql`
      SELECT to_char(min(first_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start FROM (
        SELECT min(start_at) AS first_at FROM (${intervals}) known GROUP BY board_id, climb_uuid, angle
        HAVING sum(extract(epoch FROM (end_at - start_at))) >= 14 * 86400
      ) of_age
    `),
    );
    if (!first.start) return null;
    await assertRawCandidates(tx, rankingTickCandidatesSql(sprayScope, first.start), maxCandidateTicks);
    scores = quietRankScores(sprayScope, first.start, intervals);
  } else if (mode === 'MOST_DISCUSSED') {
    await assertRawCandidates(tx, rankingCommentCandidatesSql(scope, sql`1`, false), maxCandidateComments);
    scores = commentRankScores(scope, rankingCommentCandidatesSql(scope, sql`*`, true), eligibility);
  } else {
    await assertRawCandidates(tx, rankingTickCandidatesSql(scope, scope.current.startAt), maxCandidateTicks);
    scores = tickRankScores(scope, mode, eligibility);
  }
  const order = sql`${scoreOrder[mode]}, variant.physical_board_uuid COLLATE "C",
    variant.board_type COLLATE "C", variant.climb_uuid COLLATE "C", variant.angle, variant.is_mirror`;
  const voteMode = mode === 'TOP_RATED' || mode === 'GRADE_FEEDBACK' ? mode : null;
  return sql`
    WITH inventory AS MATERIALIZED (${inventory}),
    configurations AS MATERIALIZED (${configurationsSql(scope)}),
    ${
      voteMode
        ? sql`
      vote_grade_scale(board_type, difficulty, grade_step) AS (${gradeScaleSql(scope)}),
      vote_activity AS MATERIALIZED (${rankingVoteActivity(scope, voteMode, eligibility)}),
    `
        : sql``
    }
    ordered AS (
    SELECT row_number() OVER (ORDER BY ${order})::int AS rank, configs.name AS "boardName",
      variant.physical_board_uuid AS "physicalBoardUuid", ${targetProjection()} AS target,
      variant."sendCount", variant."senderCount", variant."voterCount", variant."commentCount", variant."authorCount",
      variant."qualityMean"::float8, variant."gradeDelta"::float8, variant."firstKnownAvailableAt",
      variant."lastSendAt", variant."lastSendEndAt", variant."lastSendDate",
      variant."knownLifetimeDays"::float8, variant."knownWindowDays"::float8, variant."sendsPerDay"::float8
    FROM (${scores}) variant
    JOIN configurations configs USING (board_id)
    JOIN board_climbs ON board_climbs.uuid = variant.climb_uuid AND board_climbs.board_type = variant.board_type
    ${currentReferenceGradeJoins()}
    ORDER BY ${order} LIMIT ${rankingLimit + 1}
    )
    SELECT coalesce((SELECT json_agg(ordered ORDER BY rank) FROM ordered), '[]'::json) AS rows,
      ${voteMode ? sql`EXISTS (SELECT 1 FROM vote_activity WHERE precision = 'unknown')` : sql`false`} AS incomplete
  `;
}

async function readRows(
  tx: GymReportingTransaction,
  scope: GymReportingScope,
  mode: GymClimbRankingMode,
  boards: InventoryBoard[],
): Promise<GymClimbRankingRow[]> {
  const statement = await prepareRankingRowsStatement(tx, scope, mode, boards);
  if (!statement) return [];
  const [result] = rowsFromResult<{ rows: GymClimbRankingRow[]; incomplete: boolean }>(await tx.execute(statement));
  // A relevant unresolved day could be later than an exact vote that survived.
  // Hide this mode's result until the source can prove the ordering.
  if (result.incomplete)
    throw new GraphQLError('Climb ranking time evidence is unavailable', {
      extensions: { code: 'TEMPORARILY_UNAVAILABLE' },
    });
  return result.rows;
}

export async function readRanking(
  tx: GymReportingTransaction,
  freshScope: GymReportingScope,
  mode: GymClimbRankingMode,
  cursor?: string | null,
): Promise<GymClimbRankings> {
  const prior = cursor ? continuation(cursor) : null;
  if (
    cursor &&
    (!prior || prior.asOf > freshScope.asOf || Date.parse(freshScope.asOf) - Date.parse(prior.asOf) >= receiptMs)
  ) {
    return emptyReport(mode, 'PAGE_CHANGED');
  }
  const scope = prior
    ? {
        ...freshScope,
        asOf: prior.asOf,
        ...(await readReportingBoundaries(tx, freshScope.timeZone, prior.asOf, freshScope.periodDays, true)),
      }
    : freshScope;
  const boards = await readInventoryBoards(tx, scope, false);
  await assertInventoryWorkBounded(tx, boards);
  const quietAvailable = boards.some(({ readySprayBinding }) => readySprayBinding !== null);
  const safeRows = await readRows(tx, scope, mode, boards);
  const truncated = safeRows.length > rankingLimit;
  const rows = safeRows.slice(0, rankingLimit);
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        scope.viewerId,
        scope.gym.uuid,
        scope.boardUuid,
        scope.periodDays,
        scope.timeZone,
        scope.timeZoneConfigured,
        scope.asOf,
        mode,
        quietAvailable,
        rows,
        truncated,
      ]),
    )
    .digest('hex');
  if (prior && prior.fingerprint !== fingerprint) return emptyReport(mode, 'PAGE_CHANGED', undefined, quietAvailable);
  const page = prior?.page ?? 0;
  return {
    ...emptyReport(mode, 'READY', scope, quietAvailable),
    rows: rows.slice(page * pageSize, (page + 1) * pageSize),
    nextCursor:
      rows.length > (page + 1) * pageSize
        ? Buffer.from(JSON.stringify({ page: page + 1, asOf: scope.asOf, fingerprint })).toString('base64url')
        : null,
    truncated,
  };
}

function sectionStatus(error: unknown): GymClimbRankingStatus | null {
  const failure = error as { code?: string; cause?: { code?: string }; extensions?: { code?: string } } | null;
  const code = failure?.extensions?.code ?? failure?.code ?? failure?.cause?.code;
  if (code === 'SCOPE_TOO_LARGE' || code === 'EXPOSURE_UNAVAILABLE' || code === 'TEMPORARILY_UNAVAILABLE') return code;
  return code === '57014' || code === '55P03' || code === '40001' ? 'TEMPORARILY_UNAVAILABLE' : null;
}

export const gymClimbRankingQueries = {
  gymClimbRankings: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireReportingUser(ctx);
    const request = validateInput(rankingInput, input, 'input');
    await applyRateLimit(ctx, options.readsPerMinute, options.operation);
    const readOptions = { ...options, chargeRate: false };
    if (request.mode === 'QUIET_CLIMBS' && !request.cursor) {
      try {
        const candidate = await withGymReportingScope(
          request,
          ctx,
          async (tx, scope) => {
            const boards = await readInventoryBoards(tx, scope, false);
            const spray = boards.flatMap(({ readySprayBinding }) => (readySprayBinding ? [readySprayBinding] : []));
            return { scope, bindings: await chooseSprayObservationBindings(tx, spray) };
          },
          readOptions,
        );
        await observeSprayInventory(candidate.scope, candidate.bindings);
      } catch {
        // Observation is opportunistic. The report rechecks access and can still read committed ranges.
      }
    }
    try {
      return await withGymReportingScope(
        request,
        ctx,
        (tx, scope) => readRanking(tx, scope, request.mode, request.cursor),
        readOptions,
      );
    } catch (error) {
      const status = sectionStatus(error);
      if (status) return emptyReport(request.mode, status);
      throw error;
    }
  },

  gymClimbRankingTarget: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    const request = validateInput(targetInput, input, 'input');
    return withGymReportingScope(
      request,
      ctx,
      async (tx, scope) => {
        const boards = await readInventoryBoards(tx, scope, false);
        const board = boards.find(({ uuid }) => uuid === request.logicalBoardUuid);
        if (!board || !validRankingOrientation(board, request.angle, request.isMirror)) throw reportingBoardNotFound();
        const eligibility =
          board.boardType === 'spray'
            ? sql`JOIN board_climbs ON board_climbs.uuid = activity.climb_uuid
            WHERE ${board.readySprayBinding !== null && !request.isMirror && request.angle === board.angle}
              AND ${sprayInventoryClimbCondition(board.layoutId)}`
            : sql`JOIN board_climbs ON board_climbs.uuid = activity.climb_uuid
            WHERE ${ledRankingVariantCondition(board, sql`activity.angle`, sql`activity.is_mirror`)}`;
        const [target] = rowsFromResult<{ target: GymClimbRankingTarget }>(
          await tx.execute(sql`
        WITH configurations AS (${configurationsSql(scope)}),
        eligible AS (
          SELECT activity.* FROM (
            SELECT ${board.id}::bigint AS board_id, ${board.boardType}::text AS board_type,
              ${request.climbUuid}::text AS climb_uuid, ${request.angle}::int AS angle, ${request.isMirror}::boolean AS is_mirror
          ) activity ${eligibility}
        )
        SELECT ${targetProjection()} AS target FROM eligible variant
        JOIN configurations configs USING (board_id)
        JOIN board_climbs ON board_climbs.board_type = variant.board_type AND board_climbs.uuid = variant.climb_uuid
        ${currentReferenceGradeJoins()}
      `),
        );
        if (!target) throw reportingBoardNotFound();
        return target.target;
      },
      { ...options, operation: 'gym-climb-ranking-target' },
    );
  },
};
