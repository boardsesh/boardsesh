import { sql, type SQL } from 'drizzle-orm';

/** The supported PostgreSQL TZif artifacts are audited for this offset and transition envelope. */
export const REPORTING_OFFSET_ENVELOPE_HOURS = 36;
const OFFSET_SAMPLE_SECONDS = 60 * 60;

const asUtc = (wallTime: SQL) => sql`timezone(interval '0', ${wallTime})`;
const offsetAt = (epoch: SQL, zone: SQL) => {
  const instant = sql`to_timestamp(${epoch}::double precision)`;
  return sql`extract(epoch FROM (timezone(${zone}, ${instant}) - timezone(interval '0', ${instant})))`;
};

export function hasReportingCalendarZoneSql(zone: SQL): SQL {
  return sql`(${zone} = 'UTC' OR (
    ${zone} ~ '^[A-Za-z_]+(/[A-Za-z0-9_+\\-]+)+$'
    AND ${zone} NOT LIKE 'posix/%' AND ${zone} NOT LIKE 'right/%'
    AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ${zone})
  ))`;
}

type CalendarOptions = { sampleBudget: number; preferredTimeZone?: string };

/**
 * Read the actual UTC spans of civil periods on the PostgreSQL calendar. The input sets
 * zone (text), wall_start and wall_end (naive timestamps), and weight (integer).
 * A supported skipped period has an empty span set. A failed proof has null spans.
 */
export function reportingCivilPeriodsSql(periods: SQL, { sampleBudget, preferredTimeZone }: CalendarOptions): SQL {
  const padding = sql`make_interval(hours => ${REPORTING_OFFSET_ENVELOPE_HOURS}::int)`;
  return sql`
    WITH RECURSIVE requested AS MATERIALIZED (
      SELECT zone, wall_start, wall_end, sum(weight) AS weight,
        CASE WHEN wall_start < wall_end
            AND wall_start = date_trunc('second', wall_start)
            AND wall_end = date_trunc('second', wall_end)
          THEN tstzrange(${asUtc(sql`wall_start`)} - ${padding},
                         ${asUtc(sql`wall_end`)} + ${padding}, '[)')
        END AS outer_span
      FROM (${periods}) periods
      GROUP BY zone, wall_start, wall_end
    ),
    named_envelopes AS (
      SELECT zone, unnest(range_agg(outer_span)) AS envelope, sum(weight) AS weight
      FROM requested
      WHERE zone <> 'UTC' AND outer_span IS NOT NULL
        AND ${hasReportingCalendarZoneSql(sql`requested.zone`)}
      GROUP BY zone
    ),
    envelope_seconds AS (
      SELECT zone, envelope, weight, extract(epoch FROM lower(envelope))::bigint AS first_second,
        extract(epoch FROM upper(envelope))::bigint AS last_second
      FROM named_envelopes
    ),
    work_budget AS (
      SELECT *, sum((last_second - first_second + ${OFFSET_SAMPLE_SECONDS - 1}) / ${OFFSET_SAMPLE_SECONDS} + 1)
        OVER (ORDER BY zone IS DISTINCT FROM ${preferredTimeZone ?? null}::text, weight DESC, zone, first_second
          ROWS UNBOUNDED PRECEDING) AS required_samples
      FROM envelope_seconds
    ),
    offset_samples AS MATERIALIZED (
      SELECT zone, envelope, first_second, last_second, epoch, ${offsetAt(sql`epoch`, sql`zone`)} AS utc_offset
      FROM work_budget
      CROSS JOIN LATERAL (
        SELECT generate_series(first_second, last_second, ${OFFSET_SAMPLE_SECONDS}) AS epoch
        UNION ALL
        SELECT last_second WHERE (last_second - first_second) % ${OFFSET_SAMPLE_SECONDS} <> 0
      ) sample_points
      WHERE required_samples <= ${sampleBudget}
    ),
    sample_brackets AS (
      SELECT *, lead(epoch) OVER bracket AS next_epoch, lead(utc_offset) OVER bracket AS next_offset
      FROM offset_samples
      WINDOW bracket AS (PARTITION BY zone, envelope ORDER BY epoch)
    ),
    -- The artifact audit guarantees at most one change in an hour. Bisect
    -- differing brackets down to the UTC second when the new offset starts.
    transition_search(zone, envelope, low, high, old_offset, new_offset, valid) AS (
      SELECT zone, envelope, epoch, next_epoch, utc_offset, next_offset, true
      FROM sample_brackets WHERE utc_offset <> next_offset
      UNION ALL
      SELECT search.zone, search.envelope,
        CASE WHEN middle.utc_offset = search.old_offset THEN midpoint.epoch ELSE search.low END,
        CASE WHEN middle.utc_offset = search.new_offset THEN midpoint.epoch ELSE search.high END,
        search.old_offset, search.new_offset, middle.utc_offset IN (search.old_offset, search.new_offset)
      FROM transition_search search
      CROSS JOIN LATERAL (SELECT search.low + (search.high - search.low) / 2 AS epoch) midpoint
      CROSS JOIN LATERAL (SELECT ${offsetAt(sql`midpoint.epoch`, sql`search.zone`)} AS utc_offset) middle
      WHERE search.valid AND search.high - search.low > 1
    ),
    search_results AS (
      SELECT zone, envelope, high AS epoch, new_offset AS utc_offset, valid
      FROM transition_search WHERE NOT valid OR high - low = 1
    ),
    proved_envelopes AS (
      SELECT sample.zone, sample.envelope
      FROM offset_samples sample
      GROUP BY sample.zone, sample.envelope
      HAVING bool_and(abs(sample.utc_offset) < ${REPORTING_OFFSET_ENVELOPE_HOURS * 3600}
        AND trunc(sample.utc_offset) = sample.utc_offset)
        AND NOT EXISTS (
          SELECT 1 FROM search_results search
          WHERE search.zone = sample.zone AND search.envelope = sample.envelope AND NOT search.valid
        )
    ),
    starts AS (
      SELECT zone, envelope, epoch, utc_offset
      FROM offset_samples WHERE epoch = first_second
      UNION ALL
      SELECT zone, envelope, epoch, utc_offset FROM search_results WHERE valid
    ),
    segments AS (
      SELECT starts.zone, starts.envelope, to_timestamp(epoch::double precision) AS start_at,
        to_timestamp(lead(epoch, 1, extract(epoch FROM upper(starts.envelope))::bigint) OVER (
          PARTITION BY starts.zone, starts.envelope ORDER BY epoch
        )::double precision) AS end_at,
        make_interval(secs => utc_offset::double precision) AS utc_offset
      FROM starts JOIN proved_envelopes USING (zone, envelope)
    ),
    projected AS (
      SELECT requested.zone, requested.wall_start, requested.wall_end,
        greatest(segment.start_at, ${asUtc(sql`requested.wall_start`)} - segment.utc_offset) AS start_at,
        least(segment.end_at, ${asUtc(sql`requested.wall_end`)} - segment.utc_offset) AS end_at
      FROM requested
      JOIN segments segment ON segment.zone = requested.zone AND segment.envelope @> requested.outer_span
    ),
    actual_periods AS (
      SELECT zone, wall_start, wall_end,
        coalesce(
          range_agg(CASE WHEN start_at < end_at THEN tstzrange(start_at, end_at, '[)') END),
          '{}'::tstzmultirange
        ) AS spans
      FROM projected GROUP BY zone, wall_start, wall_end
    )
    SELECT zone, wall_start, wall_end, spans FROM actual_periods
    UNION ALL
    SELECT zone, wall_start, wall_end, tstzmultirange(tstzrange(${asUtc(sql`wall_start`)}, ${asUtc(sql`wall_end`)}, '[)'))
    FROM requested WHERE zone = 'UTC' AND outer_span IS NOT NULL
  `;
}
