import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
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
import { resolveGymReportingTimeZone } from '../../../services/gym-reporting-time-zone';
import { resolveGymAddressLocation, type GymAddressLocation } from '../../../services/gym-address-location';
import { GymStatsInputSchema } from '../../../validation/schemas/gyms';
import { applyRateLimit, validateInput } from '../shared/helpers';
import {
  BOARD_CONFIG_PRESENCE_SLUG_PREFIX,
  isSharedConfigFeedBoard,
  SYSTEM_BOARD_OWNER_ID,
} from '../board-presence/shared';
import { requireGymEditAccess } from './gyms';
import {
  hasReportingCalendarZoneSql,
  REPORTING_OFFSET_ENVELOPE_HOURS,
  reportingCivilPeriodsSql,
} from './gym-reporting-calendar';

const PERIOD_DAYS: Record<GymStatsPeriod, number> = { week: 7, month: 30, quarter: 90 };
const FIRST_OBSERVED_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;

export type ReportingWindow = { startAt: string; endAt: string };
export type GymReportingTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type AuthorizedBoard = Pick<
  typeof userBoards.$inferSelect,
  'id' | 'uuid' | 'name' | 'boardType' | 'ownerId' | 'slug' | 'hasLeds'
>;
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
  addressLocation?: GymAddressLocation | null;
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
  microseconds = false,
): Promise<{ current: ReportingWindow; previous: ReportingWindow }> {
  const stampFormat = microseconds ? 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"' : 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
  const [window] = rowsFromResult<{ currentStart: string; previousStart: string }>(
    await tx.execute(sql`
    WITH wall_clock AS (SELECT ${asOf}::timestamptz AT TIME ZONE ${timeZone} AS local_as_of)
    SELECT
      to_char(((local_as_of - make_interval(days => ${periodDays}::int)) AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC',
              ${stampFormat}) AS "currentStart",
      to_char(((local_as_of - make_interval(days => ${periodDays * 2}::int)) AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC',
              ${stampFormat}) AS "previousStart"
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

const reportingBoardColumns = {
  id: userBoards.id,
  uuid: userBoards.uuid,
  name: userBoards.name,
  boardType: userBoards.boardType,
  slug: userBoards.slug,
  ownerId: userBoards.ownerId,
  hasLeds: userBoards.hasLeds,
};

type BoundedReportingOptions = { maxBoards: number; operation: string; readsPerMinute: number; chargeRate?: boolean };

function excludesSharedFeed(): SQL {
  return sql`NOT (${userBoards.ownerId} = ${SYSTEM_BOARD_OWNER_ID}
    AND starts_with(${userBoards.slug}, ${BOARD_CONFIG_PRESENCE_SLUG_PREFIX}))`;
}

export async function readBoundedReportingClock(tx: GymReportingTransaction): Promise<string> {
  const [clock] = rowsFromResult<{ asOf: string }>(
    await tx.execute(sql`
    SELECT set_config('statement_timeout', '2000ms', true),
      to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "asOf"
  `),
  );
  return clock.asOf;
}

async function readBoundedReportingBoards(
  tx: GymReportingTransaction,
  gymId: number,
  viewerId: string,
  boardUuid: string | null | undefined,
  gymIds: number[],
  maxBoards: number,
): Promise<AuthorizedBoard[]> {
  const boardAccess = and(authorizedReportingBoardCondition(gymId, viewerId), excludesSharedFeed());
  const activeAlias = and(inArray(gymReportingBoardAliases.gymId, gymIds), isNull(gymReportingBoardAliases.revokedAt));
  if (!boardUuid) {
    return tx
      .select(reportingBoardColumns)
      .from(userBoards)
      .where(boardAccess)
      .limit(maxBoards + 1);
  }

  const [selected] = await tx
    .select(reportingBoardColumns)
    .from(userBoards)
    .where(and(boardAccess, eq(userBoards.uuid, boardUuid)))
    .limit(1);
  if (!selected) throw reportingBoardNotFound();
  const [alias] = await tx
    .select({ root: gymReportingBoardAliases.rootBoardId })
    .from(gymReportingBoardAliases)
    .where(and(activeAlias, eq(gymReportingBoardAliases.boardId, selected.id)))
    .limit(1);

  let root = selected;
  if (alias) {
    const [eligibleRoot] = await tx
      .select(reportingBoardColumns)
      .from(userBoards)
      .where(and(boardAccess, eq(userBoards.id, alias.root), eq(userBoards.boardType, selected.boardType)))
      .limit(1);
    if (!eligibleRoot) return [selected];
    const [higherAlias] = await tx
      .select({ id: gymReportingBoardAliases.id })
      .from(gymReportingBoardAliases)
      .where(and(activeAlias, eq(gymReportingBoardAliases.boardId, eligibleRoot.id)))
      .limit(1);
    if (higherAlias) return [selected];
    root = eligibleRoot;
  }
  const members = tx
    .select({ id: gymReportingBoardAliases.boardId })
    .from(gymReportingBoardAliases)
    .where(and(activeAlias, eq(gymReportingBoardAliases.rootBoardId, root.id)));
  return tx
    .select(reportingBoardColumns)
    .from(userBoards)
    .where(
      and(
        boardAccess,
        eq(userBoards.boardType, root.boardType),
        or(eq(userBoards.id, root.id), inArray(userBoards.id, members)),
      ),
    )
    .limit(maxBoards + 1);
}

export async function withGymReportingScope<Result>(
  input: unknown,
  ctx: ConnectionContext,
  callback: (tx: GymReportingTransaction, scope: GymReportingScope) => Promise<Result>,
  bounded?: BoundedReportingOptions,
): Promise<Result> {
  const viewerId = requireReportingUser(ctx);
  if (bounded?.chargeRate !== false) {
    await applyRateLimit(ctx, bounded?.readsPerMinute ?? 30, bounded?.operation ?? 'gymStats');
  }
  const { gymUuid, boardUuid: requestedBoardUuid, period } = validateInput(GymStatsInputSchema, input, 'input');
  // Address lookup may use HTTP; complete it before borrowing a reporting
  // transaction connection. The snapshot independently checks the current row.
  const addressLocation = await resolveGymAddressLocation(await requireGymEditAccess(gymUuid, viewerId));
  const legacyAsOf = bounded ? null : new Date().toISOString();
  return db.transaction(
    async (tx) => {
      const asOf = legacyAsOf ?? (await readBoundedReportingClock(tx));
      const gym = await requireGymEditAccess(gymUuid, viewerId, tx);
      const reportingTimeZone = await resolveGymReportingTimeZone(gym, tx, addressLocation);
      const timeZone = reportingTimeZone ?? 'UTC';
      const periodDays = PERIOD_DAYS[period];
      const canonicalGymIds = await readReportingGymIds(tx, gym.id);
      const authorizedBoards = bounded
        ? await readBoundedReportingBoards(tx, gym.id, viewerId, requestedBoardUuid, canonicalGymIds, bounded.maxBoards)
        : (
            await tx
              .select(reportingBoardColumns)
              .from(userBoards)
              .where(authorizedReportingBoardCondition(gym.id, viewerId))
              .orderBy(asc(userBoards.name), asc(userBoards.id))
          ).filter((board) => !isSharedConfigFeedBoard(board));
      if (bounded && authorizedBoards.length > bounded.maxBoards) {
        throw new GraphQLError('Reporting scope is too large', { extensions: { code: 'SCOPE_TOO_LARGE' } });
      }
      if (bounded) authorizedBoards.sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
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
      const { current, previous } = await readReportingBoundaries(tx, timeZone, asOf, periodDays, !!bounded);
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
        timeZoneConfigured: reportingTimeZone !== null,
        periodDays,
        current,
        previous,
        addressLocation,
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
  sendsOnly?: boolean;
  includeBoardsWhen?: SQL;
  identifiedOnly?: boolean;
} & (
  | { firstObservedOnly?: false; start?: string; predecessorDaysOnly?: false }
  | { firstObservedOnly?: false; start: string; predecessorDaysOnly: true }
  // The first-observed probes must have both index bounds before their LIMIT.
  | { firstObservedOnly: true; start: string; predecessorDaysOnly?: never }
);

/** An author date and its attested saved time can differ by at most this much in UTC. */
export const REPORTING_AUTHOR_OVERHANG_HOURS = 24 + 2 * REPORTING_OFFSET_ENVELOPE_HOURS;
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
    -- Share each bounded calendar projection across the candidate records.
    WITH author_calendar AS MATERIALIZED (${authorCalendar}),
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
    gym_calendar AS MATERIALIZED (${gymCalendar})
    SELECT tick.*, author.possible_start_at, author.possible_end_at, author.spans AS possible_spans,
      CASE WHEN tick.candidate_precision = 'instant' THEN (tick.occurred_at AT TIME ZONE ${timeZone})::date
        WHEN author.author_zone = ${timeZone} OR gym.spans @> author.spans THEN author.gym_day END AS local_date,
      CASE WHEN tick.candidate_precision = 'day' AND author.spans IS NULL THEN 'unknown'
        ELSE tick.candidate_precision END AS precision
    FROM candidate_ticks tick
    LEFT JOIN proved_author_days author ON author.activity_id = tick.activity_id
    LEFT JOIN gym_calendar gym ON gym.wall_start = author.gym_day::timestamp
  `;
}

function reportingScopedBoardsSql(scope: GymReportingScope): SQL {
  // The null seed preserves the column types for an empty authorized selection.
  return scope.activityBoards.length > 0
    ? sql.join(
        scope.activityBoards.map(({ id, physicalBoardUuid }) => sql`(${id}::bigint, ${physicalBoardUuid}::text)`),
        sql`, `,
      )
    : sql`(NULL::bigint, NULL::text)`;
}

const reportingAcceptedGymsSql = (scope: GymReportingScope) =>
  sql.join(
    scope.canonicalGymIds.map((id) => sql`${id}`),
    sql`, `,
  );
const certifiedTickTime = sql`tick.reporting_climbed_at = tick.climbed_at`;
function reportingAuthorDayContainsSavedTimeSql(authorDate: SQL, zone: SQL, storedAt: SQL): SQL {
  return sql`(${authorDate} BETWEEN date '0001-01-01' AND date '9999-12-31'
    AND CASE WHEN ${hasReportingCalendarZoneSql(zone)}
      THEN (${timestampUtc(storedAt)} AT TIME ZONE ${zone})::date = ${authorDate}
      ELSE false END)`;
}

const certifiedTickAuthorDay = sql`(${certifiedTickTime} AND tick.reporting_time_precision = 'day'
  AND ${reportingAuthorDayContainsSavedTimeSql(
    sql`tick.reporting_date`,
    sql`tick.reporting_date_time_zone`,
    sql`tick.climbed_at`,
  )})`;
const certifiedTickInstant = sql`(${certifiedTickTime} AND tick.reporting_time_precision = 'instant')`;
// This static superset matches the partial index. It lets the board-only
// probe bypass certified exact ticks before checking a possible author day.
const unboundedTickEvidence = sql`(
  (tick.reporting_time_precision IS DISTINCT FROM 'instant' OR tick.reporting_climbed_at IS DISTINCT FROM tick.climbed_at)
  AND (${certifiedTickInstant} OR ${certifiedTickAuthorDay}) IS NOT TRUE
)`;
const authorOffsetEnvelope = sql`make_interval(hours => ${REPORTING_OFFSET_ENVELOPE_HOURS}::int)`;

type ReportingSourceBounds = {
  start?: SQL | null;
  end?: SQL;
  actorFilter: SQL;
  identifiedOnly?: boolean;
  tail: SQL;
};

function reportingDisplaySourceSql(
  scope: GymReportingScope,
  { start: beginUtc, end: endUtc, actorFilter, identifiedOnly, tail }: ReportingSourceBounds,
): SQL {
  const acceptedGyms = reportingAcceptedGymsSql(scope);
  const displayActor = sql`CASE WHEN display.reporting_board_id IS NOT NULL OR display.identity_policy_version > 0
    THEN ${identifiedActor(sql`display.user_id`, sql`display.board_id`, scope.viewerId)} END`;
  const displayClimb = sql`COALESCE(display_alias.canonical_uuid, display.climb_uuid)`;
  return sql`
      SELECT 'display'::text AS source, display.id::text AS activity_id, display.board_id,
        selected.physical_board_uuid, display.board_type, ${displayClimb} AS climb_uuid,
        display.angle, display.reporting_mirrored AS is_mirror,
        ${displayActor} AS actor_id,
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
        ${endUtc ? sql`AND display.confirmed_at < ${endUtc}` : sql``}
        ${beginUtc ? sql`AND display.confirmed_at >= ${beginUtc}` : sql``}
        ${actorFilter}
        ${identifiedOnly ? sql`AND (${displayActor}) IS NOT NULL` : sql``}
        AND (
          (display.reporting_board_id = display.board_id AND display.reporting_gym_id IN (${acceptedGyms}))
          OR (display.reporting_board_id IS NULL AND logical.owner_id <> ${SYSTEM_BOARD_OWNER_ID} AND NOT EXISTS (
            SELECT 1 FROM user_boards previously_merged WHERE previously_merged.merged_into_board_uuid = logical.uuid
          ))
        )
        AND ${historicalClimbAllowed(sql`display.board_type`, sql`logical.layout_id`, displayClimb, scope.viewerId)}
        ${tail}
  `;
}

function reportingTickSourceSql(
  scope: GymReportingScope,
  { start: tickBegin, end: tickEnd, actorFilter, identifiedOnly, tail }: ReportingSourceBounds,
): SQL {
  const acceptedGyms = reportingAcceptedGymsSql(scope);
  const tickActor = identifiedActor(sql`tick.user_id`, sql`tick.board_id`, scope.viewerId);
  const tickClimb = sql`COALESCE(tick_alias.canonical_uuid, tick.climb_uuid)`;
  const certifiedTime = certifiedTickTime;
  return sql`
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
        ${tickEnd ? sql`AND tick.climbed_at < ${tickEnd}` : sql``}
        ${tickBegin ? sql`AND tick.climbed_at >= ${tickBegin}` : sql``}
        ${actorFilter}
        ${identifiedOnly ? sql`AND (${tickActor}) IS NOT NULL` : sql``}
        AND ${contentVisibilityCondition('tick', sql`tick.uuid`, sql`tick.user_id`, scope.viewerId)}
        AND ${historicalClimbAllowed(sql`tick.board_type`, sql`logical.layout_id`, tickClimb, scope.viewerId)}
        ${tail}
  `;
}

/**
 * For C/P candidate actors only. Earlier instants and suitably old certified
 * days can be proved from the source indexes without normalizing old calendars.
 * Missing or mismatched occurrence evidence has no justified date cutoff.
 */
export function reportingEarlierActivitySql(
  scope: GymReportingScope,
  actor: SQL,
  probe: { kind: 'definite'; cutoff: string } | { kind: 'unbounded' },
): SQL {
  const cutoffUtc = probe.kind === 'definite' ? sql`(${probe.cutoff}::timestamptz AT TIME ZONE 'UTC')` : undefined;
  const tickActor = identifiedActor(sql`tick.user_id`, sql`tick.board_id`, scope.viewerId);
  const tick = reportingTickSourceSql(scope, {
    end: cutoffUtc,
    actorFilter: sql`AND tick.user_id = ${actor} AND ${tickActor} IS NOT NULL`,
    tail: cutoffUtc
      ? sql`AND (${certifiedTickInstant} OR (${certifiedTickAuthorDay}
        AND (tick.reporting_date + 1)::timestamp + ${authorOffsetEnvelope} <= ${cutoffUtc}))`
      : sql`AND ${unboundedTickEvidence}`,
  });
  const displayActor = identifiedActor(sql`display.user_id`, sql`display.board_id`, scope.viewerId);
  const display = cutoffUtc
    ? reportingDisplaySourceSql(scope, {
        end: cutoffUtc,
        actorFilter: sql`AND display.user_id = ${actor} AND display.user_id IS NOT NULL
      AND (display.reporting_board_id IS NOT NULL OR display.identity_policy_version > 0)
      AND ${displayActor} IS NOT NULL`,
        tail: sql``,
      })
    : undefined;
  return sql`(
    WITH scoped_boards(board_id, physical_board_uuid) AS (VALUES ${reportingScopedBoardsSql(scope)})
    SELECT
      ${display ? sql`EXISTS (SELECT 1 FROM scoped_boards selected CROSS JOIN LATERAL (${display}) earlier_display) OR` : sql``}
      EXISTS (SELECT 1 FROM scoped_boards selected CROSS JOIN LATERAL (${tick}) earlier_tick)
  )`;
}

/**
 * Compact unbounded evidence for window coverage. Neither the nominal tick
 * timestamp nor the report scan range excludes such a record from a window.
 * No calendar projection runs here. Actor IDs remain in the aggregate SQL.
 */
export function reportingUnboundedTickEvidenceSql(scope: GymReportingScope): SQL {
  const possibleTicks = reportingTickSourceSql(scope, {
    actorFilter: sql``,
    tail: sql`AND ${unboundedTickEvidence}`,
  });
  return sql`
    WITH scoped_boards(board_id, physical_board_uuid) AS (VALUES ${reportingScopedBoardsSql(scope)})
    SELECT eligible.actor_id, bool_or(eligible.status IN ('flash', 'send')) AS possible_send
    FROM scoped_boards selected CROSS JOIN LATERAL (${possibleTicks}) eligible
    WHERE eligible.actor_id IS NOT NULL OR eligible.status IN ('flash', 'send')
    GROUP BY eligible.actor_id
  `;
}

/** Busy-only reads need a single existence result, using the same partial index as Reach. */
export function reportingHasUnboundedIdentifiedTimeSql(scope: GymReportingScope): SQL {
  const tick = reportingTickSourceSql(scope, {
    actorFilter: sql``,
    identifiedOnly: true,
    tail: sql`AND ${unboundedTickEvidence}`,
  });
  return sql`EXISTS (
    WITH scoped_boards(board_id, physical_board_uuid) AS (VALUES ${reportingScopedBoardsSql(scope)})
    SELECT 1 FROM scoped_boards selected CROSS JOIN LATERAL (${tick}) eligible
  )`;
}

/** Shared, authorized physical scope. Caller aggregates the rows in SQL and returns no identity list. */
export function reportingActivitySql(scope: GymReportingScope, bounds: ReportingActivityBounds): SQL {
  const endUtc = sql`(${bounds.end}::timestamptz AT TIME ZONE 'UTC')`;
  const beginUtc = bounds.start ? sql`(${bounds.start}::timestamptz AT TIME ZONE 'UTC')` : null;
  const authorOverhang = sql`make_interval(hours => ${REPORTING_AUTHOR_OVERHANG_HOURS}::int)`;
  const tickBegin = beginUtc && !bounds.firstObservedOnly ? sql`${beginUtc} - ${authorOverhang}` : beginUtc;
  const tickEnd = bounds.firstObservedOnly ? endUtc : sql`${endUtc} + ${authorOverhang}`;
  const boundActor = (column: SQL) =>
    bounds.candidateActorIds ? sql`AND ${column} IN (${bounds.candidateActorIds})` : sql``;

  const tickTimes = bounds.firstObservedOnly
    ? sql`SELECT tick.*, NULL::timestamptz AS possible_start_at, NULL::timestamptz AS possible_end_at,
        (tick.occurred_at AT TIME ZONE ${scope.timeZone})::date AS local_date, 'instant'::text AS precision,
        NULL::tstzmultirange AS possible_spans
        FROM candidate_ticks tick`
    : reportingTickTimesSql(scope.timeZone);

  const scopedBoards = reportingScopedBoardsSql(scope);
  const enabledBoards = bounds.includeBoardsWhen
    ? sql`SELECT * FROM (VALUES ${scopedBoards}) selected WHERE ${bounds.includeBoardsWhen}`
    : sql`VALUES ${scopedBoards}`;

  return sql`
    WITH scoped_boards(board_id, physical_board_uuid) AS (${enabledBoards}),
    precise_displays AS (
      SELECT eligible.* FROM scoped_boards selected
      CROSS JOIN LATERAL (
      ${reportingDisplaySourceSql(scope, {
        start: beginUtc,
        end: endUtc,
        actorFilter: boundActor(sql`display.user_id`),
        identifiedOnly: bounds.identifiedOnly,
        tail:
          bounds.sendsOnly || bounds.predecessorDaysOnly
            ? sql`AND false`
            : bounds.firstObservedOnly
              ? sql`ORDER BY display.confirmed_at LIMIT 1`
              : sql``,
      })}
      ) eligible
    ),
    candidate_ticks AS ${bounds.firstObservedOnly ? sql`` : sql`MATERIALIZED`} (
      SELECT eligible.* FROM scoped_boards selected
      CROSS JOIN LATERAL (
      ${reportingTickSourceSql(scope, {
        start: tickBegin,
        end: tickEnd,
        actorFilter: boundActor(sql`tick.user_id`),
        identifiedOnly: bounds.identifiedOnly,
        tail: sql`
          ${bounds.sendsOnly ? sql`AND tick.status IN ('flash', 'send')` : sql``}
          ${
            bounds.firstObservedOnly
              ? sql`AND ${certifiedTickTime} AND tick.reporting_time_precision = 'instant' ORDER BY tick.climbed_at LIMIT 1`
              : bounds.predecessorDaysOnly
                ? sql`AND ${certifiedTickAuthorDay}`
                : sql``
          }
        `,
      })}
      ) eligible
    ),
    timed_ticks AS (${tickTimes}),
    timed_evidence AS (
      SELECT *,
        CASE WHEN precision = 'unknown' THEN
          CASE WHEN candidate_precision = 'day'
            AND ${reportingAuthorDayContainsSavedTimeSql(sql`author_date`, sql`author_zone`, sql`stored_at`)}
          THEN tstzrange(
            ${timestampUtc(sql`author_date::timestamp`)} - ${authorOffsetEnvelope},
            ${timestampUtc(sql`(author_date + 1)::timestamp`)} + ${authorOffsetEnvelope}, '[)'
          ) END
        END AS uncertainty_span
      FROM timed_ticks
    )
    SELECT *, NULL::tstzrange AS uncertainty_span, NULL::tstzmultirange AS possible_spans
    FROM precise_displays
    UNION ALL
    SELECT source, activity_id, board_id, physical_board_uuid, board_type, climb_uuid, angle, is_mirror, actor_id,
      occurred_at, possible_start_at, possible_end_at, local_date, precision, attribution, status, quality, difficulty,
      uncertainty_span, possible_spans
    FROM timed_evidence
    WHERE (precision = 'instant' AND occurred_at < ${bounds.end}::timestamptz
      ${bounds.start ? sql`AND occurred_at >= ${bounds.start}::timestamptz` : sql``})
      OR (precision = 'day' AND possible_start_at < ${bounds.end}::timestamptz
        AND possible_end_at > possible_start_at
        ${bounds.start ? sql`AND possible_end_at > ${bounds.start}::timestamptz` : sql``})
      OR (precision = 'unknown' AND (
        (uncertainty_span IS NULL AND stored_at < ${endUtc})
        OR (lower(uncertainty_span) < ${bounds.end}::timestamptz
          ${bounds.start ? sql`AND upper(uncertainty_span) > ${bounds.start}::timestamptz` : sql``})
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
