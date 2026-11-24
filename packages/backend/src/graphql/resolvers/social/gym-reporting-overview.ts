import { sql, type SQL } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import type { GymReachCount, GymReachOverview, GymReachReturn, GymReachWindow } from '@boardsesh/shared-schema';
import {
  REPORTING_AUTHOR_OVERHANG_HOURS,
  reportingActivitySql,
  reportingEarlierActivitySql,
  reportingUnboundedTickEvidenceSql,
  type GymReportingScope,
  type GymReportingTransaction,
  type ReportingWindow,
} from './gym-reporting';

type WindowKey = 'current' | 'previous' | 'older';
type WeekWindow = ReportingWindow & { key: string; startDate: string; endDate: string; inProgress: boolean };
type ActivityWindow = {
  key: string;
  climbers: number;
  sends: number;
  sendLoggers: number;
  sessions: number;
  hadActivity: boolean;
  reachUncertain: boolean;
  sendsUncertain: boolean;
  sessionsUncertain: boolean;
};
type Cohorts = {
  returned: number;
  olderReturned: number;
  firstCurrent: number;
  firstPrevious: number;
  uncertainCurrent: number;
  uncertainPrevious: number;
};

const isoTimestampSql = (stamp: SQL) => sql`to_char(${stamp} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

async function readOverviewWindows(tx: GymReportingTransaction, scope: GymReportingScope) {
  const windows = rowsFromResult<WeekWindow & { baselineStartAt: string }>(
    await tx.execute(sql`
      WITH wall_clock AS (
        SELECT ${scope.asOf}::timestamptz AT TIME ZONE ${scope.timeZone} AS local_as_of
      ), local_weeks AS (
        SELECT local_as_of, (date_trunc('week', local_as_of)::date - (7 * weeks_back)) AS monday, weeks_back
        FROM wall_clock CROSS JOIN generate_series(11, 0, -1) week(weeks_back)
      )
      SELECT to_char(monday, 'YYYY-MM-DD') AS key, to_char(monday, 'YYYY-MM-DD') AS "startDate",
        to_char(monday + 6, 'YYYY-MM-DD') AS "endDate" ,
        weeks_back = 0 AS "inProgress",
        ${isoTimestampSql(sql`(monday::timestamp AT TIME ZONE ${scope.timeZone})`)} AS "startAt",
        ${isoTimestampSql(sql`least((monday + 7)::timestamp AT TIME ZONE ${scope.timeZone}, ${scope.asOf}::timestamptz)`)} AS "endAt",
        ${isoTimestampSql(sql`((local_as_of - make_interval(days => ${scope.periodDays * 3}::int)) AT TIME ZONE ${scope.timeZone})`)} AS "baselineStartAt"
      FROM local_weeks ORDER BY monday
    `),
  );
  const older = { startAt: windows[0].baselineStartAt, endAt: scope.previous.startAt };
  return { older, weeks: windows };
}

function scopedFirstCountsSql(scope: GymReportingScope, window: WindowKey, cutoff: string): SQL {
  // A certified day outside this band can use the audited envelope in the
  // indexed proof. Unbounded evidence has its own actor/board existence check.
  const nearStart = new Date(Date.parse(cutoff) - REPORTING_AUTHOR_OVERHANG_HOURS * 60 * 60_000).toISOString();
  const nearActivity = reportingActivitySql(scope, {
    start: nearStart,
    end: cutoff,
    candidateActorIds: sql`SELECT actor_id FROM remaining`,
    predecessorDaysOnly: true,
  });
  return sql`
    WITH examined AS MATERIALIZED (
      SELECT candidate.actor_id,
        ${reportingEarlierActivitySql(scope, sql`candidate.actor_id`, { kind: 'definite', cutoff })} AS earlier
      FROM cohort_people candidate WHERE candidate.key = ${window}
    ), remaining AS MATERIALIZED (
      SELECT actor_id FROM examined WHERE NOT earlier
    ), near_history AS (
      SELECT actor_id,
        bool_or(precision = 'day' AND possible_end_at <= ${cutoff}::timestamptz) AS earlier,
        bool_or((precision = 'day' AND possible_end_at > ${cutoff}::timestamptz)
          OR (precision = 'unknown' AND lower(uncertainty_span) < ${cutoff}::timestamptz)) AS uncertain
      FROM (${nearActivity}) activity
      WHERE actor_id IS NOT NULL GROUP BY actor_id
    ), classified AS (
      SELECT COALESCE(near.earlier, false) AS earlier,
        CASE WHEN near.earlier IS TRUE THEN false ELSE COALESCE(near.uncertain, false)
          OR ${reportingEarlierActivitySql(scope, sql`remaining.actor_id`, { kind: 'unbounded' })} END AS uncertain
      FROM remaining LEFT JOIN near_history near USING (actor_id)
    )
    SELECT count(*) FILTER (WHERE NOT earlier AND NOT uncertain)::int AS found,
      count(*) FILTER (WHERE NOT earlier AND uncertain)::int AS uncertain
    FROM classified
  `;
}

function reachCount(count: number, complete: boolean, observed: boolean): GymReachCount {
  return { count, coverage: complete ? 'complete' : observed ? 'partial' : 'unavailable' };
}

function hasFullTemporalCoverage(window: ReportingWindow, startedAt: string | null) {
  if (!startedAt) return false;
  // PostgreSQL stamps the floor in microseconds. Compare canonical UTC strings
  // at equal precision to avoid rounding the floor back across a cutoff.
  const normalized = (instant: string) => instant.replace(/\.(\d{3})Z$/, (_, frac: string) => `.${frac}000Z`);
  const start = normalized(window.startAt);
  return start >= normalized(startedAt) && normalized(window.endAt) >= start;
}

function returnCohort(returning: number, denominator: GymReachCount, numerator: GymReachCount): GymReachReturn {
  const complete = denominator.coverage === 'complete' && numerator.coverage === 'complete';
  return {
    returning,
    previousClimbers: denominator.count,
    coverage: denominator.count === 0 ? 'unavailable' : complete ? 'complete' : 'partial',
  };
}

function makeWindow(
  activity: ActivityWindow,
  window: ReportingWindow,
  startedAt: string | null,
  first: number,
  uncertainFirst: number,
): GymReachWindow {
  const temporallyComplete = hasFullTemporalCoverage(window, startedAt);
  const reachComplete = temporallyComplete && !activity.reachUncertain;
  const sendsComplete = temporallyComplete && !activity.sendsUncertain;
  return {
    climbers: reachCount(activity.climbers, reachComplete, activity.hadActivity),
    firstRecorded: reachCount(first, reachComplete && uncertainFirst === 0, activity.climbers > 0),
    uncertainFirstRecorded: uncertainFirst,
    sends: reachCount(activity.sends, sendsComplete, activity.hadActivity),
    sendLoggers: activity.sendLoggers,
    sessions: reachCount(activity.sessions, sendsComplete && !activity.sessionsUncertain, activity.hadActivity),
  };
}

export async function readGymReachOverview(
  tx: GymReportingTransaction,
  scope: GymReportingScope,
  observationStartedAt: string | null,
): Promise<{ overview: GymReachOverview; hasUnboundedIdentifiedTime: boolean }> {
  const { older, weeks } = await readOverviewWindows(tx, scope);
  const windows = [
    { ...scope.current, key: 'current' },
    { ...scope.previous, key: 'previous' },
    { ...older, key: 'older' },
    ...weeks,
  ];
  const firstStart = [older.startAt, weeks[0].startAt].reduce((earliest, startAt) =>
    Date.parse(startAt) < Date.parse(earliest) ? startAt : earliest,
  );
  const windowValues = sql.join(
    windows.map(({ key, startAt, endAt }) => sql`(${key}::text, ${startAt}::timestamptz, ${endAt}::timestamptz)`),
    sql`, `,
  );
  const [summary] = rowsFromResult<Cohorts & { windows: ActivityWindow[]; hasUnboundedIdentifiedTime: boolean }>(
    await tx.execute(sql`
    WITH windows(key, start_at, end_at) AS (VALUES ${windowValues}),
    activity AS MATERIALIZED (
      ${reportingActivitySql(scope, { start: firstStart, end: scope.asOf })}
    ),
    assigned AS MATERIALIZED (
      SELECT windows.key, activity.actor_id, activity.local_date, activity.attribution, activity.source,
        activity.source = 'tick' AND activity.status IN ('flash', 'send') AS send,
        activity.precision = 'instant' OR (activity.precision = 'day'
          AND activity.possible_start_at >= windows.start_at AND activity.possible_end_at <= windows.end_at) AS fits
      FROM windows
      JOIN activity ON windows.start_at < windows.end_at AND (
        (activity.precision = 'instant' AND activity.occurred_at >= windows.start_at AND activity.occurred_at < windows.end_at)
        OR (activity.precision = 'day' AND activity.possible_start_at < windows.end_at AND activity.possible_end_at > windows.start_at)
        OR (activity.precision = 'unknown'
          AND activity.uncertainty_span && tstzrange(windows.start_at, greatest(windows.start_at, windows.end_at), '[)'))
      )
    ),
    actor_windows AS MATERIALIZED (
      SELECT key, actor_id, bool_or(fits) AS recorded,
        bool_or(fits AND (source <> 'display' OR attribution = 'event_time')) AS definite_membership
      FROM assigned WHERE actor_id IS NOT NULL GROUP BY key, actor_id
    ),
    unbounded AS MATERIALIZED (${reportingUnboundedTickEvidenceSql(scope)}),
    -- A definite member neutralizes the same person's possibility only for
    -- this window. This check also considers actors with unbounded evidence
    -- whose nominal logbook time is outside the entire recent scan.
    possible_membership AS (
      SELECT windows.key FROM windows
      WHERE windows.start_at < windows.end_at AND EXISTS (
        SELECT 1 FROM unbounded possible
        WHERE possible.actor_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM actor_windows person WHERE person.key = windows.key
            AND person.actor_id = possible.actor_id AND person.definite_membership
        )
      )
    ),
    totals AS (
      SELECT windows.key, count(DISTINCT actor_id) FILTER (WHERE fits)::int AS climbers,
        count(*) FILTER (WHERE fits AND send)::int AS sends,
        count(DISTINCT actor_id) FILTER (WHERE fits AND send)::int AS "sendLoggers",
        count(DISTINCT (actor_id, local_date)) FILTER (WHERE fits AND send
          AND actor_id IS NOT NULL AND local_date IS NOT NULL)::int AS sessions,
        COALESCE(bool_or(fits), false) AS "hadActivity",
        (EXISTS (SELECT 1 FROM actor_windows person WHERE person.key = windows.key AND NOT person.definite_membership)
          OR EXISTS (SELECT 1 FROM possible_membership WHERE possible_membership.key = windows.key)) AS "reachUncertain",
        (COALESCE(bool_or(send AND NOT fits), false) OR (windows.start_at < windows.end_at
          AND EXISTS (SELECT 1 FROM unbounded WHERE possible_send))) AS "sendsUncertain",
        (COALESCE(bool_or(send AND actor_id IS NOT NULL AND (NOT fits OR local_date IS NULL)), false)
          OR (windows.start_at < windows.end_at AND EXISTS (SELECT 1 FROM unbounded WHERE possible_send
            AND actor_id IS NOT NULL))) AS "sessionsUncertain"
      FROM windows LEFT JOIN assigned USING (key) GROUP BY windows.key, windows.start_at, windows.end_at
    ),
    cohort_people AS MATERIALIZED (
      SELECT key, actor_id FROM actor_windows
      WHERE recorded AND key IN ('current', 'previous', 'older')
    ),
    first_current AS (${scopedFirstCountsSql(scope, 'current', scope.current.startAt)}),
    first_previous AS (${scopedFirstCountsSql(scope, 'previous', scope.previous.startAt)})
    SELECT (SELECT json_agg(totals) FROM totals) AS windows,
      EXISTS (SELECT 1 FROM unbounded WHERE actor_id IS NOT NULL) AS "hasUnboundedIdentifiedTime",
      (SELECT count(*)::int FROM cohort_people previous JOIN cohort_people current USING (actor_id)
        WHERE previous.key = 'previous' AND current.key = 'current') AS returned,
      (SELECT count(*)::int FROM cohort_people previous JOIN cohort_people older USING (actor_id)
        WHERE previous.key = 'previous' AND older.key = 'older') AS "olderReturned",
      first_current.found AS "firstCurrent", first_current.uncertain AS "uncertainCurrent",
      first_previous.found AS "firstPrevious", first_previous.uncertain AS "uncertainPrevious"
    FROM first_current CROSS JOIN first_previous
  `),
  );

  const totals = new Map(summary.windows.map((window) => [window.key, window]));
  const current = makeWindow(
    totals.get('current')!,
    scope.current,
    observationStartedAt,
    summary.firstCurrent,
    summary.uncertainCurrent,
  );
  const previous = makeWindow(
    totals.get('previous')!,
    scope.previous,
    observationStartedAt,
    summary.firstPrevious,
    summary.uncertainPrevious,
  );
  const olderActivity = totals.get('older')!;
  const olderClimbers = reachCount(
    olderActivity.climbers,
    hasFullTemporalCoverage(older, observationStartedAt) && !olderActivity.reachUncertain,
    olderActivity.hadActivity,
  );
  const overview: GymReachOverview = {
    observationStartedAt,
    baselineStartAt: older.startAt,
    current,
    previous,
    cameBack: returnCohort(summary.returned, previous.climbers, current.climbers),
    previousCameBack: returnCohort(summary.olderReturned, olderClimbers, previous.climbers),
    weeklyTrend: weeks.map(({ startDate, endDate, inProgress, ...week }) => {
      const activity = totals.get(week.key)!;
      const complete = hasFullTemporalCoverage(week, observationStartedAt);
      return {
        startDate,
        endDate,
        inProgress,
        climbers: reachCount(activity.climbers, complete && !activity.reachUncertain, activity.climbers > 0),
        sends: reachCount(activity.sends, complete && !activity.sendsUncertain, activity.sends > 0),
      };
    }),
  };
  return { overview, hasUnboundedIdentifiedTime: summary.hasUnboundedIdentifiedTime };
}
