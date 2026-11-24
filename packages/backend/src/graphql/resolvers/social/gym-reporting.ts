import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { rowsFromResult } from '@boardsesh/db/client';
import {
  anonymousOnBoardCondition,
  climbDraftVisibilityCondition,
  contentVisibilityCondition,
  resourceAccessCondition,
  restrictedBoardMemberIdentityCondition,
  sprayClimbVisibilityCondition,
  userActivityVisibilityCondition,
} from '@boardsesh/db/queries';
import { gymMembers, gymReportingBoardAliases, userBoards } from '@boardsesh/db/schema';
import type {
  ConnectionContext,
  GymReportingBoard,
  GymReportingCoverage,
  GymStatsPeriod,
} from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { GymStatsInputSchema } from '../../../validation/schemas/gyms';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { isSharedConfigFeedBoard, SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';
import { requireGymEditAccess } from './gyms';
import { REPORTING_OFFSET_ENVELOPE_HOURS, reportingCivilPeriodsSql } from './gym-reporting-calendar';

const PERIOD_DAYS: Record<GymStatsPeriod, number> = { week: 7, month: 30, quarter: 90 };
const FIRST_OBSERVED_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;

export type ReportingWindow = { startAt: string; endAt: string };
export type GymReportingTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type AuthorizedBoard = Pick<typeof userBoards.$inferSelect, 'id' | 'uuid' | 'name' | 'boardType' | 'ownerId' | 'slug'>;
type ActivityBoard = AuthorizedBoard & { physicalBoardUuid: string };

export type GymReportingScope = {
  gym: { id: number; uuid: string; name: string };
  viewerId: string;
  boardUuid: string | null;
  boardIds: number[];
  boards: GymReportingBoard[];
  activityBoards: ActivityBoard[];
  canonicalGymIds: number[];
  canManageBoardAliases: boolean;
  asOf: string;
  timeZone: string;
  timeZoneConfigured: boolean;
  periodDays: number;
  current: ReportingWindow;
  previous: ReportingWindow;
};

export function requireReportingUser(ctx: ConnectionContext): string {
  if (ctx.isAuthenticated && ctx.userId) return ctx.userId;
  throw new GraphQLError('Authentication required to perform this operation', {
    extensions: { code: 'UNAUTHENTICATED' },
  });
}

export function reportingBoardNotFound(): GraphQLError {
  return new GraphQLError('Board not found in this gym', { extensions: { code: 'NOT_FOUND' } });
}

export function authorizedReportingBoardCondition(gymId: number, viewerId: string): SQL {
  return and(
    eq(userBoards.gymId, gymId),
    isNull(userBoards.deletedAt),
    isNull(userBoards.mergedIntoBoardUuid),
    resourceAccessCondition('board', userBoards.uuid, viewerId, { allowUnlistedLink: false }),
    sprayClimbVisibilityCondition({ boardType: userBoards.boardType, layoutId: userBoards.layoutId }, viewerId),
  )!;
}

export async function readReportingBoundaries(
  tx: GymReportingTransaction,
  timeZone: string,
  asOf: string,
  periodDays: number,
): Promise<{ current: ReportingWindow; previous: ReportingWindow }> {
  const [window] = rowsFromResult<{ currentStart: string; previousStart: string }>(
    await tx.execute(sql`
    WITH wall_clock AS (SELECT ${asOf}::timestamptz AT TIME ZONE ${timeZone} AS local_as_of)
    SELECT
      to_char(((local_as_of - make_interval(days => ${periodDays}::int)) AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "currentStart",
      to_char(((local_as_of - make_interval(days => ${periodDays * 2}::int)) AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "previousStart"
    FROM wall_clock
  `),
  );
  return {
    current: { startAt: window.currentStart, endAt: asOf },
    previous: { startAt: window.previousStart, endAt: window.currentStart },
  };
}

export async function readReportingGymIds(tx: GymReportingTransaction, gymId: number): Promise<number[]> {
  const rows = rowsFromResult<{ id: number | string }>(
    await tx.execute(sql`
    WITH RECURSIVE merged_gyms AS (
      SELECT id, ARRAY[id] AS visited FROM gyms WHERE id = ${gymId}
      UNION ALL
      SELECT previous.id, merged_gyms.visited || previous.id
      FROM gyms previous JOIN merged_gyms ON previous.merged_into_gym_id = merged_gyms.id
      WHERE previous.deleted_at IS NOT NULL
        AND NOT previous.id = ANY(merged_gyms.visited)
        AND cardinality(merged_gyms.visited) < 10
    )
    SELECT id FROM merged_gyms
  `),
  );
  return rows.map(({ id }) => Number(id));
}

function groupReportingBoards(
  authorizedBoards: AuthorizedBoard[],
  aliases: { boardId: number; rootBoardId: number }[],
): { boards: GymReportingBoard[]; activityBoards: ActivityBoard[] } {
  const byId = new Map(authorizedBoards.map((board) => [board.id, board]));
  const aliasRoots = new Map(
    aliases.flatMap(({ boardId, rootBoardId }) => {
      const board = byId.get(boardId);
      const root = byId.get(rootBoardId);
      return board && root && root.boardType === board.boardType ? [[boardId, rootBoardId] as const] : [];
    }),
  );
  const groups = new Map<string, GymReportingBoard>();
  const activityBoards = authorizedBoards.map((board) => {
    const rootId = aliasRoots.get(board.id);
    const root = rootId === undefined ? undefined : byId.get(rootId);
    const physical = root && root.boardType === board.boardType && !aliasRoots.has(root.id) ? root : board;
    const group = groups.get(physical.uuid) ?? {
      uuid: physical.uuid,
      name: physical.name,
      boardType: physical.boardType,
      configurations: [],
    };
    group.configurations.push({ uuid: board.uuid, name: board.name });
    groups.set(physical.uuid, group);
    return { ...board, physicalBoardUuid: physical.uuid };
  });
  return { boards: [...groups.values()], activityBoards };
}

export async function withGymReportingScope<Result>(
  input: unknown,
  ctx: ConnectionContext,
  callback: (tx: GymReportingTransaction, scope: GymReportingScope) => Promise<Result>,
): Promise<Result> {
  const viewerId = requireReportingUser(ctx);
  await applyRateLimit(ctx, 30, 'gymStats');
  const { gymUuid, boardUuid: requestedBoardUuid, period } = validateInput(GymStatsInputSchema, input, 'input');
  const asOf = new Date().toISOString();
  return db.transaction(
    async (tx) => {
      const gym = await requireGymEditAccess(gymUuid, viewerId, tx);
      const timeZone = gym.reportingTimeZone ?? 'UTC';
      const periodDays = PERIOD_DAYS[period];
      const canonicalGymIds = await readReportingGymIds(tx, gym.id);
      const authorizedBoards = (
        await tx
          .select({
            id: userBoards.id,
            uuid: userBoards.uuid,
            name: userBoards.name,
            boardType: userBoards.boardType,
            slug: userBoards.slug,
            ownerId: userBoards.ownerId,
          })
          .from(userBoards)
          .where(authorizedReportingBoardCondition(gym.id, viewerId))
          .orderBy(asc(userBoards.name), asc(userBoards.id))
      ).filter((board) => !isSharedConfigFeedBoard(board));
      const aliases =
        authorizedBoards.length > 0
          ? await tx
              .select({ boardId: gymReportingBoardAliases.boardId, rootBoardId: gymReportingBoardAliases.rootBoardId })
              .from(gymReportingBoardAliases)
              .where(
                and(
                  inArray(gymReportingBoardAliases.gymId, canonicalGymIds),
                  inArray(
                    gymReportingBoardAliases.boardId,
                    authorizedBoards.map(({ id }) => id),
                  ),
                  isNull(gymReportingBoardAliases.revokedAt),
                ),
              )
          : [];
      const { boards, activityBoards } = groupReportingBoards(authorizedBoards, aliases);
      const selectedBoard =
        requestedBoardUuid == null ? null : activityBoards.find((candidate) => candidate.uuid === requestedBoardUuid);
      if (requestedBoardUuid != null && !selectedBoard) throw reportingBoardNotFound();
      const boardUuid = selectedBoard?.physicalBoardUuid ?? null;
      const selectedBoards = boardUuid
        ? activityBoards.filter((board) => board.physicalBoardUuid === boardUuid)
        : activityBoards;
      const { current, previous } = await readReportingBoundaries(tx, timeZone, asOf, periodDays);
      const [adminMembership] =
        gym.ownerId === viewerId
          ? [undefined]
          : await tx
              .select({ userId: gymMembers.userId })
              .from(gymMembers)
              .where(and(eq(gymMembers.gymId, gym.id), eq(gymMembers.userId, viewerId), eq(gymMembers.role, 'admin')))
              .limit(1);
      // The bounded source plan is cheaper to interpret. Default JIT compiled
      // 774 functions for a seven-row linked-board fixture before reading it.
      await tx.execute(sql`SET LOCAL jit = off`);
      return callback(tx, {
        gym,
        viewerId,
        asOf,
        boardUuid,
        boards,
        activityBoards: selectedBoards,
        boardIds: selectedBoards.map(({ id }) => id),
        canonicalGymIds,
        canManageBoardAliases: gym.ownerId === viewerId || !!adminMembership,
        timeZone,
        timeZoneConfigured: gym.reportingTimeZone !== null,
        periodDays,
        current,
        previous,
      });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

const timestampUtc = (stamp: SQL) => sql`(${stamp} AT TIME ZONE 'UTC')`;

function identifiedActor(userId: SQL, boardId: SQL, viewerId: string): SQL {
  return sql`CASE WHEN ${userId} IS NOT NULL
    AND (${userActivityVisibilityCondition(userId, viewerId)} OR ${restrictedBoardMemberIdentityCondition(userId, boardId, viewerId)})
    AND NOT ${anonymousOnBoardCondition(userId, boardId, viewerId)}
    THEN ${userId} END`;
}

/** Existing private catalogue drafts are excluded; a retired or missing historical climb is not an inventory test. */
function historicalClimbAllowed(type: SQL, logicalLayoutId: SQL, canonicalUuid: SQL, viewerId: string): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM board_climbs historical
    WHERE historical.board_type = ${type} AND historical.uuid = ${canonicalUuid}
      AND (NOT ${climbDraftVisibilityCondition({ boardType: sql`historical.board_type`, isDraft: sql`historical.is_draft`, userId: sql`historical.user_id` }, viewerId)}
        OR (historical.board_type = 'spray' AND historical.layout_id <> ${logicalLayoutId}))
  )`;
}

/** Apply to a relation named `activity` from reportingActivitySql. */
export function reportingActivityInWindowSql(window: ReportingWindow): SQL {
  return sql`(
    (activity.precision = 'instant' AND activity.occurred_at >= ${window.startAt}::timestamptz
      AND activity.occurred_at < ${window.endAt}::timestamptz)
    OR (activity.precision = 'day' AND activity.possible_start_at >= ${window.startAt}::timestamptz
      AND activity.possible_end_at <= ${window.endAt}::timestamptz
      AND activity.possible_end_at > activity.possible_start_at)
  )`;
}

type ReportingActivityBounds = {
  end: string;
  candidateActorIds?: SQL;
} & (
  | { firstObservedOnly?: false; start?: string }
  // The first-observed probes must have both index bounds before their LIMIT.
  | { firstObservedOnly: true; start: string }
);

/** An author date and its attested saved time can differ by at most this much in UTC. */
const REPORTING_AUTHOR_OVERHANG_HOURS = 24 + 2 * REPORTING_OFFSET_ENVELOPE_HOURS;
const AUTHOR_CALENDAR_SAMPLE_BUDGET = 24_000;
const GYM_CALENDAR_SAMPLE_BUDGET = 8_000;

function reportingTickTimesSql(timeZone: string): SQL {
  const authorCalendar = reportingCivilPeriodsSql(
    sql`SELECT author_zone AS zone, author_date::timestamp AS wall_start,
      (author_date + 1)::timestamp AS wall_end, count(*) AS weight
      FROM candidate_ticks
      WHERE candidate_precision = 'day' AND author_date BETWEEN date '0001-01-01' AND date '9999-12-31'
      GROUP BY author_zone, author_date`,
    { sampleBudget: AUTHOR_CALENDAR_SAMPLE_BUDGET, preferredTimeZone: timeZone },
  );
  const gymCalendar = reportingCivilPeriodsSql(
    sql`SELECT ${timeZone}::text AS zone, gym_day::timestamp AS wall_start,
      (gym_day + 1)::timestamp AS wall_end, count(*) AS weight
      FROM proved_author_days
      WHERE author_zone <> ${timeZone}
      GROUP BY gym_day`,
    { sampleBudget: GYM_CALENDAR_SAMPLE_BUDGET },
  );
  return sql`
    WITH author_calendar AS (${authorCalendar}),
    proved_author_days AS MATERIALIZED (
      SELECT tick.activity_id, tick.author_zone, calendar.spans,
        lower(range_merge(calendar.spans)) AS possible_start_at,
        upper(range_merge(calendar.spans)) AS possible_end_at,
        (lower(range_merge(calendar.spans)) AT TIME ZONE ${timeZone})::date AS gym_day
      FROM candidate_ticks tick
      JOIN author_calendar calendar ON calendar.zone = tick.author_zone
        AND calendar.wall_start = tick.author_date::timestamp
      WHERE tick.candidate_precision = 'day'
        AND calendar.spans @> ${timestampUtc(sql`tick.stored_at`)}
    ),
    gym_calendar AS (${gymCalendar})
    SELECT tick.*, author.possible_start_at, author.possible_end_at,
      CASE WHEN tick.candidate_precision = 'instant' THEN (tick.occurred_at AT TIME ZONE ${timeZone})::date
        WHEN author.author_zone = ${timeZone} OR gym.spans @> author.spans THEN author.gym_day END AS local_date,
      CASE WHEN tick.candidate_precision = 'day' AND author.spans IS NULL THEN 'unknown'
        ELSE tick.candidate_precision END AS precision
    FROM candidate_ticks tick
    LEFT JOIN proved_author_days author ON author.activity_id = tick.activity_id
    LEFT JOIN gym_calendar gym ON gym.wall_start = author.gym_day::timestamp
  `;
}

/** Shared, authorized physical scope. Caller aggregates the rows in SQL and returns no identity list. */
export function reportingActivitySql(scope: GymReportingScope, bounds: ReportingActivityBounds): SQL {
  // An empty scope uses a typed null row in VALUES then filters it out. This
  // keeps the same column types and predicates for every downstream caller.
  const scopedBoards =
    scope.activityBoards.length > 0
      ? sql.join(
          scope.activityBoards.map(({ id, physicalBoardUuid }) => sql`(${id}::bigint, ${physicalBoardUuid}::text)`),
          sql`, `,
        )
      : sql`(NULL::bigint, NULL::text)`;
  const acceptedGyms = sql.join(
    scope.canonicalGymIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const endUtc = sql`(${bounds.end}::timestamptz AT TIME ZONE 'UTC')`;
  const beginUtc = bounds.start ? sql`(${bounds.start}::timestamptz AT TIME ZONE 'UTC')` : null;
  const authorOverhang = sql`make_interval(hours => ${REPORTING_AUTHOR_OVERHANG_HOURS}::int)`;
  const tickBegin = beginUtc && !bounds.firstObservedOnly ? sql`${beginUtc} - ${authorOverhang}` : beginUtc;
  const tickEnd = bounds.firstObservedOnly ? endUtc : sql`${endUtc} + ${authorOverhang}`;
  const displayActor = identifiedActor(sql`display.user_id`, sql`display.board_id`, scope.viewerId);
  const tickActor = identifiedActor(sql`tick.user_id`, sql`tick.board_id`, scope.viewerId);
  const displayClimb = sql`COALESCE(display_alias.canonical_uuid, display.climb_uuid)`;
  const tickClimb = sql`COALESCE(tick_alias.canonical_uuid, tick.climb_uuid)`;
  const certifiedTime = sql`tick.reporting_climbed_at = tick.climbed_at`;
  const boundActor = (column: SQL) =>
    bounds.candidateActorIds ? sql`AND ${column} IN (${bounds.candidateActorIds})` : sql``;

  const tickTimes = bounds.firstObservedOnly
    ? sql`SELECT tick.*, NULL::timestamptz AS possible_start_at, NULL::timestamptz AS possible_end_at,
        (tick.occurred_at AT TIME ZONE ${scope.timeZone})::date AS local_date, 'instant'::text AS precision
        FROM candidate_ticks tick`
    : reportingTickTimesSql(scope.timeZone);

  return sql`
    WITH scoped_boards(board_id, physical_board_uuid) AS (VALUES ${scopedBoards}),
    precise_displays AS (
      SELECT eligible.* FROM scoped_boards selected
      CROSS JOIN LATERAL (
      SELECT 'display'::text AS source, display.id::text AS activity_id, display.board_id,
        selected.physical_board_uuid, display.board_type, ${displayClimb} AS climb_uuid,
        display.angle, display.reporting_mirrored AS is_mirror,
        CASE WHEN display.reporting_board_id IS NOT NULL OR display.identity_policy_version > 0
          THEN ${displayActor} END AS actor_id,
        ${timestampUtc(sql`display.confirmed_at`)} AS occurred_at,
        NULL::timestamptz AS possible_start_at, NULL::timestamptz AS possible_end_at,
        (${timestampUtc(sql`display.confirmed_at`)} AT TIME ZONE ${scope.timeZone})::date AS local_date,
        'instant'::text AS precision,
        CASE WHEN display.reporting_board_id IS NULL THEN 'current_board' ELSE 'event_time' END AS attribution,
        NULL::text AS status, NULL::int AS quality, NULL::int AS difficulty
      FROM board_climb_events display
      JOIN user_boards logical ON logical.id = display.board_id
      LEFT JOIN board_climb_aliases display_alias ON display_alias.board_type = display.board_type
        AND display_alias.alias_uuid = display.climb_uuid
      WHERE display.board_id = selected.board_id AND display.source = 'boardsesh' AND display.board_type = logical.board_type
        AND display.confirmed_at < ${endUtc}
        ${beginUtc ? sql`AND display.confirmed_at >= ${beginUtc}` : sql``}
        ${boundActor(sql`display.user_id`)}
        AND (
          (display.reporting_board_id = display.board_id AND display.reporting_gym_id IN (${acceptedGyms}))
          OR (display.reporting_board_id IS NULL AND logical.owner_id <> ${SYSTEM_BOARD_OWNER_ID} AND NOT EXISTS (
            SELECT 1 FROM user_boards previously_merged WHERE previously_merged.merged_into_board_uuid = logical.uuid
          ))
        )
        AND ${historicalClimbAllowed(sql`display.board_type`, sql`logical.layout_id`, displayClimb, scope.viewerId)}
        ${bounds.firstObservedOnly ? sql`ORDER BY display.confirmed_at LIMIT 1` : sql``}
      ) eligible
    ),
    candidate_ticks AS ${bounds.firstObservedOnly ? sql`` : sql`MATERIALIZED`} (
      SELECT eligible.* FROM scoped_boards selected
      CROSS JOIN LATERAL (
      SELECT 'tick'::text AS source, tick.id::text AS activity_id, tick.board_id,
        selected.physical_board_uuid, tick.board_type, ${tickClimb} AS climb_uuid,
        tick.angle, tick.is_mirror, ${tickActor} AS actor_id,
        CASE WHEN ${certifiedTime} AND tick.reporting_time_precision = 'instant' THEN ${timestampUtc(sql`tick.climbed_at`)} END AS occurred_at,
        tick.reporting_date AS author_date, tick.reporting_date_time_zone AS author_zone,
        CASE WHEN ${certifiedTime} THEN COALESCE(tick.reporting_time_precision, 'unknown')
          ELSE 'unknown' END AS candidate_precision, 'current_board'::text AS attribution,
        tick.status::text, tick.quality, tick.difficulty, tick.climbed_at AS stored_at
      FROM boardsesh_ticks tick
      JOIN user_boards logical ON logical.id = tick.board_id
      LEFT JOIN board_climb_aliases tick_alias ON tick_alias.board_type = tick.board_type
        AND tick_alias.alias_uuid = tick.climb_uuid
      WHERE tick.board_id = selected.board_id AND tick.origin = 'native' AND tick.board_type = logical.board_type
        AND tick.reporting_attribution IN ('uuid', 'presence', 'session', 'edit')
        AND tick.reporting_board_id = tick.board_id AND tick.reporting_gym_id IN (${acceptedGyms})
        AND tick.climbed_at < ${tickEnd}
        ${tickBegin ? sql`AND tick.climbed_at >= ${tickBegin}` : sql``}
        ${boundActor(sql`tick.user_id`)}
        AND ${contentVisibilityCondition('tick', sql`tick.uuid`, sql`tick.user_id`, scope.viewerId)}
        AND ${historicalClimbAllowed(sql`tick.board_type`, sql`logical.layout_id`, tickClimb, scope.viewerId)}
        ${bounds.firstObservedOnly ? sql`AND ${certifiedTime} AND tick.reporting_time_precision = 'instant' ORDER BY tick.climbed_at LIMIT 1` : sql``}
      ) eligible
    ),
    timed_ticks AS (${tickTimes})
    SELECT * FROM precise_displays
    UNION ALL
    SELECT source, activity_id, board_id, physical_board_uuid, board_type, climb_uuid, angle, is_mirror, actor_id,
      occurred_at, possible_start_at, possible_end_at, local_date, precision, attribution, status, quality, difficulty
    FROM timed_ticks
    WHERE (precision = 'instant' AND occurred_at < ${bounds.end}::timestamptz
      ${bounds.start ? sql`AND occurred_at >= ${bounds.start}::timestamptz` : sql``})
      OR (precision = 'day' AND possible_start_at < ${bounds.end}::timestamptz
        AND possible_end_at > possible_start_at
        ${bounds.start ? sql`AND possible_end_at > ${bounds.start}::timestamptz` : sql``})
      OR (precision = 'unknown' AND (
        stored_at < ${endUtc}
        OR (candidate_precision = 'day' AND author_date BETWEEN date '0001-01-01' AND date '9999-12-31'
          AND author_date::timestamp < ${endUtc} + make_interval(hours => ${REPORTING_OFFSET_ENVELOPE_HOURS}::int)
          ${beginUtc ? sql`AND (author_date + 1)::timestamp > ${beginUtc} - make_interval(hours => ${REPORTING_OFFSET_ENVELOPE_HOURS}::int)` : sql``})
      ))
  `;
}

export async function readGymReportingCoverage(
  tx: GymReportingTransaction,
  scope: GymReportingScope,
): Promise<GymReportingCoverage> {
  const observedSince = new Date(Date.parse(scope.asOf) - FIRST_OBSERVED_LOOKBACK_MS).toISOString();
  const [history] = rowsFromResult<{ firstDisplayAt: string | null; firstTickAt: string | null }>(
    await tx.execute(sql`
    WITH activity AS (${reportingActivitySql(scope, { start: observedSince, end: scope.asOf, firstObservedOnly: true })})
    SELECT to_char(min(occurred_at) FILTER (WHERE source = 'display') AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "firstDisplayAt",
      to_char(min(occurred_at) FILTER (WHERE source = 'tick') AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "firstTickAt"
    FROM activity
  `),
  );
  const [quality] = rowsFromResult<
    Omit<GymReportingCoverage, 'observedSince' | 'firstDisplayAt' | 'firstTickAt' | 'isPartial'>
  >(
    await tx.execute(sql`
    WITH activity AS (${reportingActivitySql(scope, { start: scope.previous.startAt, end: scope.asOf })})
    SELECT count(*) FILTER (WHERE precision = 'day' AND (${reportingActivityInWindowSql(scope.current)}
        OR ${reportingActivityInWindowSql(scope.previous)}))::int AS "dateOnlyCount",
      count(*) FILTER (WHERE precision = 'day' AND NOT (${reportingActivityInWindowSql(scope.current)}
        OR ${reportingActivityInWindowSql(scope.previous)}))::int AS "boundaryUncertainCount",
      count(*) FILTER (WHERE precision = 'unknown')::int AS "unknownTimeCount",
      COALESCE(bool_or(attribution = 'current_board'), false) AS "includesCurrentBoardHistory"
    FROM activity
  `),
  );
  return { observedSince, ...history, ...quality, isPartial: true };
}
