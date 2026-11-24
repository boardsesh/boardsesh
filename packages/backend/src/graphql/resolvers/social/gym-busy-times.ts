import { sql, type SQL } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import type { GymBusyTimes, GymBusyTimesStatus } from '@boardsesh/shared-schema';
import { REPORTING_OFFSET_ENVELOPE_HOURS, reportingCivilPeriodsSql } from './gym-reporting-calendar';
import {
  reportingActivitySql,
  reportingHasUnboundedIdentifiedTimeSql,
  type GymReportingScope,
  type GymReportingTransaction,
} from './gym-reporting';

const OBSERVATION_DAYS = 90;
const HOURS_PER_DAY = 24;
const CALENDAR_SAMPLE_BUDGET = 8_000;
// The local date may start almost one civil day before asOf's local clock.
// Two opposite legal offsets can move the UTC start another 72 elapsed hours.
const SCAN_DAYS = OBSERVATION_DAYS + 1 + (2 * REPORTING_OFFSET_ENVELOPE_HOURS) / HOURS_PER_DAY;
const DAY_MS = HOURS_PER_DAY * 60 * 60_000;

type NominalDates = { startDate: string | null; endDate: string | null };
type BusySummary = Omit<GymBusyTimes, 'status' | 'startDate' | 'endDate'> & { calendarHourCount: number };

function unavailableBusyTimes(status: GymBusyTimesStatus, dates: NominalDates): GymBusyTimes {
  const weekdays = Array.from({ length: 7 }, (_, index) => ({
    dayOfWeek: index + 1,
    eligibleDates: 0,
    recordedClimbers: 0,
  }));
  return {
    status,
    ...dates,
    coveredDates: 0,
    firstCoveredDate: null,
    instantDisplays: 0,
    instantTicks: 0,
    dateOnlyRecords: 0,
    unplacedDateOnlyRecords: 0,
    unknownTimeRecords: 0,
    hasUnboundedUnknownTime: false,
    weekdays,
    hours: weekdays.flatMap((day) => Array.from({ length: HOURS_PER_DAY }, (_, hour) => ({ ...day, hour }))),
  };
}

function busySummarySql(
  scope: GymReportingScope,
  startDate: string,
  endDate: string,
  observationStartAt: string,
  knownUnboundedTime: boolean | undefined,
): SQL {
  const calendar = reportingCivilPeriodsSql(
    sql`
      SELECT ${scope.timeZone}::text AS zone, period AS wall_start, period + interval '1 hour' AS wall_end, 1 AS weight
      FROM generate_series(
        ${startDate}::date::timestamp, ${endDate}::date::timestamp + interval '23 hours', interval '1 hour'
      ) AS nominal(period)
    `,
    { sampleBudget: CALENDAR_SAMPLE_BUDGET },
  );
  const calendarScanStart = new Date(Date.parse(scope.asOf) - SCAN_DAYS * DAY_MS).toISOString();
  const scanStart =
    Date.parse(observationStartAt) > Date.parse(calendarScanStart) ? observationStartAt : calendarScanStart;
  const hasUnbounded =
    knownUnboundedTime === undefined
      ? reportingHasUnboundedIdentifiedTimeSql(scope)
      : sql`${knownUnboundedTime}::boolean`;
  return sql`
    WITH calendar_hours AS MATERIALIZED (
      SELECT wall_start::date AS civil_date, extract(hour FROM wall_start)::int AS hour, spans FROM (${calendar}) parsed
    ),
    calendar_days AS (
      SELECT civil_date, extract(isodow FROM civil_date)::int AS weekday, range_agg(spans) AS spans
      FROM calendar_hours GROUP BY civil_date
    ),
    covered_days AS MATERIALIZED (
      SELECT * FROM calendar_days
      WHERE (SELECT count(*) FROM calendar_hours) = ${OBSERVATION_DAYS * HOURS_PER_DAY}
        AND NOT isempty(spans)
        AND lower(range_merge(spans)) >= ${observationStartAt}::timestamptz
        AND upper(range_merge(spans)) <= ${scope.asOf}::timestamptz
    ),
    covered_hours AS (
      SELECT day.weekday, clock.hour
      FROM covered_days day JOIN calendar_hours clock USING (civil_date)
      WHERE NOT isempty(clock.spans)
    ),
    covered_span AS (
      SELECT count(*)::int AS date_count, min(civil_date)::text AS first_date, range_agg(spans) AS spans
      FROM covered_days
    ),
    identified AS MATERIALIZED (
      SELECT activity.*
      FROM covered_span
      CROSS JOIN LATERAL (${reportingActivitySql(scope, {
        start: scanStart,
        end: scope.asOf,
        includeBoardsWhen: sql`covered_span.date_count > 0`,
        identifiedOnly: true,
      })}) activity
      WHERE covered_span.date_count > 0
    ),
    placed AS MATERIALIZED (
      SELECT day.civil_date, day.weekday, activity.actor_id, activity.source, activity.precision,
        CASE WHEN activity.precision = 'instant'
          THEN extract(hour FROM activity.occurred_at AT TIME ZONE ${scope.timeZone})::int END AS hour
      FROM identified activity
      JOIN covered_days day ON activity.local_date = day.civil_date
      WHERE activity.precision = 'day'
        OR (activity.precision = 'instant' AND day.spans @> activity.occurred_at)
    ),
    day_people AS (
      SELECT weekday, count(*)::int AS people
      FROM (SELECT DISTINCT weekday, civil_date, actor_id FROM placed) unique_days
      GROUP BY weekday
    ),
    hour_people AS (
      SELECT weekday, hour, count(*)::int AS people
      FROM (SELECT DISTINCT weekday, civil_date, hour, actor_id FROM placed WHERE hour IS NOT NULL) unique_hours
      GROUP BY weekday, hour
    ),
    weekday_denominators AS (
      SELECT weekday, count(*)::int AS eligible FROM covered_days GROUP BY weekday
    ),
    hour_denominators AS (
      SELECT weekday, hour, count(*)::int AS eligible FROM covered_hours GROUP BY weekday, hour
    ),
    weekdays AS (
      SELECT spine.weekday AS "dayOfWeek", COALESCE(denominator.eligible, 0) AS "eligibleDates",
        COALESCE(counted.people, 0) AS "recordedClimbers"
      FROM generate_series(1, 7) AS spine(weekday)
      LEFT JOIN weekday_denominators denominator USING (weekday)
      LEFT JOIN day_people counted USING (weekday)
    ),
    hours AS (
      SELECT weekday AS "dayOfWeek", hour, COALESCE(denominator.eligible, 0) AS "eligibleDates",
        COALESCE(counted.people, 0) AS "recordedClimbers"
      FROM (SELECT * FROM generate_series(1, 7) AS days(weekday)
            CROSS JOIN generate_series(0, 23) AS day_hours(hour)) spine
      LEFT JOIN hour_denominators denominator USING (weekday, hour)
      LEFT JOIN hour_people counted USING (weekday, hour)
    ),
    quality AS (
      SELECT count(*) FILTER (WHERE precision = 'day' AND possible_spans && covered_span.spans)::int AS date_only,
        count(*) FILTER (WHERE precision = 'day' AND possible_spans && covered_span.spans
          AND NOT EXISTS (SELECT 1 FROM covered_days day WHERE day.civil_date = activity.local_date))::int AS unplaced,
        count(*) FILTER (WHERE precision = 'unknown' AND
          (uncertainty_span IS NULL OR covered_span.spans && uncertainty_span))::int AS uncertain
      FROM identified activity CROSS JOIN covered_span
    )
    SELECT (SELECT count(*)::int FROM calendar_hours) AS "calendarHourCount",
      date_count AS "coveredDates", first_date AS "firstCoveredDate",
      (SELECT count(*)::int FROM placed WHERE precision = 'instant' AND source = 'display') AS "instantDisplays",
      (SELECT count(*)::int FROM placed WHERE precision = 'instant' AND source = 'tick') AS "instantTicks",
      quality.date_only AS "dateOnlyRecords", quality.unplaced AS "unplacedDateOnlyRecords",
      quality.uncertain AS "unknownTimeRecords",
      CASE WHEN date_count > 0 THEN ${hasUnbounded} ELSE false END AS "hasUnboundedUnknownTime",
      (SELECT json_agg(weekdays ORDER BY "dayOfWeek") FROM weekdays) AS weekdays,
      (SELECT json_agg(hours ORDER BY "dayOfWeek", hour) FROM hours) AS hours
    FROM covered_span CROSS JOIN quality
  `;
}

export async function readGymBusyTimes(
  tx: GymReportingTransaction,
  scope: GymReportingScope,
  observationStartAt: string | null,
  knownUnboundedTime?: boolean,
): Promise<GymBusyTimes> {
  if (!scope.timeZoneConfigured) return unavailableBusyTimes('zoneRequired', { startDate: null, endDate: null });
  const [dates] = rowsFromResult<{ startDate: string; endDate: string }>(
    await tx.execute(sql`
      SELECT to_char(today - ${OBSERVATION_DAYS}::int, 'YYYY-MM-DD') AS "startDate",
        to_char(today - 1, 'YYYY-MM-DD') AS "endDate"
      FROM (SELECT (${scope.asOf}::timestamptz AT TIME ZONE ${scope.timeZone})::date AS today) clock
    `),
  );
  if (!observationStartAt || scope.boardIds.length === 0) return unavailableBusyTimes('historyUnavailable', dates);

  const [{ calendarHourCount, ...summary }] = rowsFromResult<BusySummary>(
    await tx.execute(busySummarySql(scope, dates.startDate, dates.endDate, observationStartAt, knownUnboundedTime)),
  );
  if (calendarHourCount !== OBSERVATION_DAYS * HOURS_PER_DAY) {
    return unavailableBusyTimes('calendarUnavailable', dates);
  }
  return { ...dates, ...summary, status: summary.coveredDates > 0 ? 'ready' : 'historyUnavailable' };
}
