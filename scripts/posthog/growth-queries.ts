/** Versioned native-production metrics. See docs/growth-metrics.md for denominators. */
import { SHARED_EVENTS } from '../../packages/shared/analytics/src/events';
export const DASHBOARD_ID = 2170056;
export const PROJECT_ID = 412845;
export const WINDOW_ANCHOR = '2026-10-09';
export const PRODUCTION_START = '2026-07-25';
export const NEWCOMER_START = '2026-09-07';
/** Earliest verified event: 2018-12-30T15:56:19Z (historical logbook backfill). */
export const HISTORY_START = '2018-12-30';
/** Keep completed six-period acquisition cohorts after their final interval matures. */
export const ACQUISITION_HISTORY_DAYS = 365;
export const RELEASED_ANDROID_BUILDS = ['2001018', '2001108'] as const;

export interface QuerySources {
  days: string;
  newcomers: string;
  /** Exclusive UTC midnight. Override only for reproducible validation. */
  cutoff: string;
}

export const LIVE_SOURCES: QuerySources = {
  days: 'growth_native_person_days',
  newcomers: 'growth_native_newcomers',
  cutoff: "toDate(toTimeZone(now(), 'UTC'))",
};

export function fixedWindowEnd(cutoff: string): string {
  return `toDate('${WINDOW_ANCHOR}') + 28 * toInt(floor(dateDiff('day', toDate('${WINDOW_ANCHOR}'), ${cutoff}) / 28))`;
}

const nativeFilter = `properties.$lib = 'posthog-react-native'
    AND properties.environment = 'production'
    AND person_id NOT IN COHORT 295337`;
const utcDay = "toDate(toTimeZone(timestamp, 'UTC'))";
const eventNames = SHARED_EVENTS;

function completedWindowEnd(sources: QuerySources): string {
  return fixedWindowEnd(
    `least(${sources.cutoff}, coalesce((SELECT max(computed_as_of) FROM ${sources.days}), ${sources.cutoff}))`,
  );
}

/** Full bounded refresh deliberately repairs identity merges beyond an incremental lookback. */
export const personDaysQuery = `SELECT
  toString(person_id) AS person_id,
  ${utcDay} AS activity_day,
  uniqExactIf(uuid, event = '$screen') AS app_views,
  uniqExactIf(uuid, event = '${eventNames.ClimbSentToBoardSuccess}') AS board_sends,
  uniqExactIf(uuid, event = '${eventNames.TickLogged}') AS ticks,
  uniqExactIf(uuid, event = '${eventNames.TickLogged}' AND properties.hasQuality = true) AS quality_ratings,
  uniqExactIf(uuid, event = '${eventNames.TickLogged}' AND properties.hasDifficulty = true) AS grade_ratings,
  uniqExactIf(uuid, event = '${eventNames.ClimbCreated}' AND properties.isDraft = false) AS published_creations,
  uniqExactIf(uuid, event = '${eventNames.ClimbCreated}' AND properties.isDraft = true) AS draft_creations,
  uniqExactIf(uuid, event = '${eventNames.ClimbCreated}' AND properties.isDraft IS NULL) AS unknown_creations,
  toDate(toTimeZone(now(), 'UTC')) AS computed_as_of
FROM events
WHERE timestamp >= greatest(toDate('${PRODUCTION_START}'), ${fixedWindowEnd(LIVE_SOURCES.cutoff)} - 168)
  AND timestamp < toDate(toTimeZone(now(), 'UTC'))
  AND ${nativeFilter}
  AND event IN ('$screen', '${eventNames.ClimbSentToBoardSuccess}', '${eventNames.TickLogged}', '${eventNames.ClimbCreated}')
GROUP BY person_id, activity_day`;

/** Historical backfill is included in first-ever checks, restricted to recent candidate identities. */
export const newcomersQuery = `WITH
  toDate(toTimeZone(now(), 'UTC')) AS cutoff,
  candidates AS (
    SELECT person_id AS person_id
    FROM events
    WHERE timestamp >= greatest(toDate('${NEWCOMER_START}'), cutoff - ${ACQUISITION_HISTORY_DAYS})
      AND timestamp < cutoff AND ${nativeFilter} AND event = '$screen'
    GROUP BY person_id
  ),
  history AS (
    SELECT person_id AS person_id,
      min(timestamp) AS first_ever_at,
      minIf(timestamp, properties.$lib = 'posthog-react-native' AND properties.environment = 'production') AS first_native_at,
      minIf(timestamp, properties.$lib = 'posthog-react-native' AND properties.environment = 'production' AND event = '$screen') AS acquired_at,
      argMinIf(toString(properties.$app_version), timestamp, properties.$lib = 'posthog-react-native' AND properties.environment = 'production') AS entry_version,
      argMinIf(toString(properties.$app_build), timestamp, properties.$lib = 'posthog-react-native' AND properties.environment = 'production') AS entry_build,
      argMinIf(toString(properties.$os), timestamp, properties.$lib = 'posthog-react-native' AND properties.environment = 'production') AS entry_os,
      argMinIf(toString(properties.$geoip_country_code), timestamp, properties.$lib = 'posthog-react-native' AND properties.environment = 'production') AS country,
      minIf(timestamp, event = '$pageview' AND properties.$lib = 'js') AS landing_at,
      argMinIf(toString(properties.$current_url), timestamp, event = '$pageview' AND properties.$lib = 'js') AS landing_url,
      argMinIf(toString(properties.$referring_domain), timestamp, event = '$pageview' AND properties.$lib = 'js') AS landing_referrer
    FROM events
    WHERE timestamp >= '${HISTORY_START}' AND timestamp < cutoff
      AND person_id IN (SELECT person_id FROM candidates)
    GROUP BY person_id
  ),
  phantoms AS (
    SELECT DISTINCT anonymous.person_id AS person_id
    FROM events AS identity_event
    JOIN person_distinct_ids AS anonymous ON anonymous.distinct_id = toString(identity_event.properties.$anon_distinct_id)
    JOIN persons AS anonymous_person ON anonymous_person.id = anonymous.person_id
    WHERE identity_event.timestamp >= '${PRODUCTION_START}' AND identity_event.timestamp < cutoff
      AND identity_event.event = '$identify'
      AND identity_event.properties.$lib = 'posthog-react-native'
      AND identity_event.properties.environment = 'production'
      AND identity_event.properties.$anon_distinct_id IS NOT NULL
      AND toString(identity_event.properties.$anon_distinct_id) != identity_event.distinct_id
      AND anonymous.person_id != identity_event.person_id
      AND coalesce(toString(anonymous_person.properties.email), '') = ''
      AND anonymous.person_id IN (SELECT person_id FROM candidates)
  ),
  entrants AS (
    SELECT history.person_id AS person_id, acquired_at AS acquired_at,
      toDate(toTimeZone(acquired_at, 'UTC')) AS acquired_day,
      first_native_at AS first_native_at, entry_os AS platform, entry_version AS entry_version,
      entry_build AS entry_build, country AS country,
      if(landing_at >= first_ever_at AND landing_at <= first_native_at, landing_at, NULL) AS first_landing_at,
      if(landing_at >= first_ever_at AND landing_at <= first_native_at, landing_url, '') AS first_landing_url,
      if(landing_at >= first_ever_at AND landing_at <= first_native_at, landing_referrer, '') AS first_referrer,
      coalesce(toString(account.properties.first_seen_at), '') AS account_created_text,
      coalesce(toString(account.properties.install_source), '') AS install_source,
      coalesce(toString(account.properties.install_medium), '') AS install_medium,
      coalesce(toString(account.properties.install_campaign), '') AS install_campaign,
      toFloatOrZero(toString(account.properties.install_begin_timestamp)) AS install_begin_seconds,
      cutoff AS computed_as_of
    FROM history
    JOIN persons AS account ON account.id = history.person_id
    WHERE acquired_at >= greatest(toDate('${NEWCOMER_START}'), cutoff - ${ACQUISITION_HISTORY_DAYS})
      AND first_native_at >= greatest(toDate('${NEWCOMER_START}'), cutoff - ${ACQUISITION_HISTORY_DAYS})
      AND first_ever_at >= first_native_at - INTERVAL 1 HOUR
      AND acquired_at < cutoff
      AND history.person_id NOT IN (SELECT person_id FROM phantoms)
      AND entry_version NOT IN ('2.3.0', '2.3.1')
      AND (entry_os != 'Android' OR entry_build IN (${RELEASED_ANDROID_BUILDS.map((build) => `'${build}'`).join(', ')}))
  ),
  native_facts AS (
    SELECT person_id AS person_id,
      groupUniqArrayIf(timestamp, event = '${eventNames.SignupCompleted}'
        OR (event IN ('${eventNames.LoginSucceeded}', '${eventNames.LoginAccountAgeResolved}') AND properties.is_new_account = true)) AS registration_timestamps,
      groupUniqArrayIf(timestamp, event = '${eventNames.ClimbSentToBoardSuccess}') AS board_timestamps,
      groupUniqArrayIf(timestamp, event = '$screen') AS app_timestamps,
      groupUniqArrayIf(timestamp, event = '${eventNames.ClimbSearchPerformed}') AS search_timestamps,
      groupUniqArrayIf(timestamp, event = '${eventNames.BluetoothConnectionSuccess}') AS connection_timestamps
    FROM events
    WHERE timestamp >= greatest(toDate('${NEWCOMER_START}'), cutoff - ${ACQUISITION_HISTORY_DAYS})
      AND timestamp < cutoff AND ${nativeFilter}
      AND person_id IN (SELECT person_id FROM entrants)
      AND event IN ('$screen', '${eventNames.SignupCompleted}', '${eventNames.LoginSucceeded}',
        '${eventNames.LoginAccountAgeResolved}', '${eventNames.ClimbSentToBoardSuccess}',
        '${eventNames.ClimbSearchPerformed}', '${eventNames.BluetoothConnectionSuccess}')
    GROUP BY person_id
  ),
  observed AS (
    SELECT entrants.*,
      accurateCastOrNull(entrants.account_created_text, 'DateTime64(6)') AS account_created_at,
      arraySort(arrayFilter(registration_time -> registration_time >= entrants.acquired_at,
        native_facts.registration_timestamps)) AS registration_times,
      length(registration_times) AS registration_evidence,
      registration_times[1] AS explicit_registration_at,
      arrayFilter(board_time -> board_time >= entrants.acquired_at, native_facts.board_timestamps) AS board_timestamps,
      arrayDistinct(arrayMap(app_time -> toDate(toString(toTimeZone(app_time, 'UTC'))),
        arrayFilter(app_time -> app_time >= entrants.acquired_at, native_facts.app_timestamps))) AS app_days,
      length(arrayFilter(search_time -> search_time >= entrants.acquired_at
        AND toDate(toString(toTimeZone(search_time, 'UTC'))) < entrants.acquired_day + 28, native_facts.search_timestamps)) AS first28_searches,
      length(arrayFilter(connection_time -> connection_time >= entrants.acquired_at
        AND toDate(toString(toTimeZone(connection_time, 'UTC'))) < entrants.acquired_day + 28, native_facts.connection_timestamps)) AS first28_connections
    FROM entrants JOIN native_facts ON native_facts.person_id = entrants.person_id
  ),
  registered AS (
    SELECT *,
      multiIf(registration_evidence > 0, explicit_registration_at,
        account_created_at >= acquired_at AND account_created_at < acquired_day + 28, account_created_at, NULL) AS registered_at,
      platform = 'Android' AND install_begin_seconds > 0
        AND install_begin_seconds <= toFloat(toUnixTimestamp(first_native_at))
        AND install_begin_seconds >= toFloat(toUnixTimestamp(first_native_at)) - 86400 AS valid_install_touch,
      lower(decodeURLComponent(extractURLParameter(first_landing_url, 'utm_source'))) AS web_source,
      lower(decodeURLComponent(extractURLParameter(first_landing_url, 'utm_medium'))) AS web_medium,
      decodeURLComponent(extractURLParameter(first_landing_url, 'utm_campaign')) AS web_campaign,
      lower(first_referrer) AS referrer
    FROM observed
  ),
  attributed AS (
    SELECT *,
      valid_install_touch AND (
        install_source NOT IN ('', '(not set)', 'google-play')
        OR (install_source = 'google-play' AND install_medium = 'organic')
        OR install_campaign NOT IN ('', '(not set)')
        OR install_medium NOT IN ('', '(not set)', 'organic')) AS meaningful_install_touch,
      first_landing_url != '' AND (web_source NOT IN ('', '(not set)', 'direct')
        OR web_medium NOT IN ('', '(not set)') OR web_campaign NOT IN ('', '(not set)')
        OR referrer NOT IN ('', 'boardsesh.com', 'www.boardsesh.com', '$direct')) AS meaningful_web_touch
    FROM registered
  ),
  first_touch AS (
    SELECT *, meaningful_install_touch AND (NOT meaningful_web_touch
      OR install_begin_seconds <= toFloat(toUnixTimestamp(first_landing_at))) AS use_install_touch
    FROM attributed
  ),
  milestones AS (
    SELECT *,
      arraySort(groupUniqArrayArray) AS ordered_board_days
    FROM (
      SELECT *,
        arrayDistinct(arrayMap(board_time -> toDate(toString(toTimeZone(board_time, 'UTC'))),
          arrayFilter(board_time -> registered_at IS NOT NULL AND board_time >= registered_at
            AND toDate(toString(toTimeZone(board_time, 'UTC'))) < acquired_day + 28, board_timestamps))) AS groupUniqArrayArray
      FROM first_touch
    )
  )
SELECT
  toString(person_id) AS person_id, acquired_at AS acquired_at, acquired_day AS acquired_day,
  platform AS platform, entry_version AS entry_version, entry_build AS entry_build, country AS country,
  registered_at AS registered_at,
  registered_at IS NOT NULL AND registered_at < acquired_day + 28 AS registered_first28,
  length(ordered_board_days) AS ordered_board_days_first28,
  length(arrayDistinct(arrayMap(board_time -> toDate(toString(toTimeZone(board_time, 'UTC'))),
    arrayFilter(board_time -> toDate(toString(toTimeZone(board_time, 'UTC'))) < acquired_day + 28, board_timestamps)))) AS board_days_first28,
  length(arrayFilter(board_time -> toDate(toString(toTimeZone(board_time, 'UTC'))) < acquired_day + 28, board_timestamps)) AS board_sends_first28,
  arrayExists(board_time -> toDate(toString(toTimeZone(board_time, 'UTC'))) = acquired_day + 28, board_timestamps) AS board_day28,
  arrayExists(board_time -> toDate(toString(toTimeZone(board_time, 'UTC'))) >= acquired_day + 28
    AND toDate(toString(toTimeZone(board_time, 'UTC'))) < acquired_day + 56, board_timestamps) AS board_next28,
  arrayExists(app_day -> app_day = acquired_day + 28, app_days) AS app_day28,
  arrayExists(app_day -> app_day >= acquired_day + 28 AND app_day < acquired_day + 56, app_days) AS app_next28,
  app_days AS app_days,
  arrayDistinct(arrayMap(board_time -> toDate(toString(toTimeZone(board_time, 'UTC'))), board_timestamps)) AS board_days,
  first28_searches AS first28_searches, first28_connections AS first28_connections,
  multiIf(use_install_touch AND lower(install_source) IN ('reddit', 'community'), 'Reddit / community',
    use_install_touch AND install_source = 'google-play' AND install_medium = 'organic', 'Organic Google Play',
    use_install_touch, 'Other identifiable',
    web_source IN ('reddit', 'community') OR referrer IN ('reddit.com', 'www.reddit.com', 'old.reddit.com', 'm.reddit.com', 'out.reddit.com'), 'Reddit / community',
    meaningful_web_touch, 'Other identifiable',
    'Direct / unknown') AS acquisition_source,
  multiIf(use_install_touch, 'timestamp-matched Play referrer',
    meaningful_web_touch, 'identity-linked first web landing',
    'unavailable') AS attribution_evidence,
  if(use_install_touch, install_campaign, if(meaningful_web_touch, web_campaign, '')) AS first_campaign,
  first_landing_url AS first_landing_url, computed_as_of AS computed_as_of
FROM milestones`;

export function bucketsQuery(sources: QuerySources = LIVE_SOURCES): string {
  return `WITH ${completedWindowEnd(sources)} AS period_end,
  previous AS (
    SELECT person_id AS person_id, countIf(board_sends > 0) AS board_days
    FROM ${sources.days}
    WHERE activity_day >= period_end - 56 AND activity_day < period_end - 28
      AND activity_day >= toDate('${PRODUCTION_START}')
    GROUP BY person_id HAVING board_days > 0
  ),
  returning AS (
    SELECT DISTINCT person_id AS person_id FROM ${sources.days}
    WHERE activity_day >= period_end - 28 AND activity_day < period_end AND board_sends > 0
  ),
  people AS (
    SELECT previous.person_id AS person_id,
      multiIf(board_days = 1, '1 day', board_days <= 3, '2–3 days', board_days <= 7, '4–7 days', '8+ days') AS bucket,
      previous.person_id IN (SELECT person_id FROM returning) AS returned
    FROM previous WHERE period_end - 56 >= toDate('${PRODUCTION_START}')
  ), totals AS (
    SELECT bucket AS frequency_bucket, count() AS previous_users, countIf(returned) AS returning_users FROM people GROUP BY bucket
    UNION ALL SELECT 'All board-active users', count(), countIf(returned) FROM people
  )
SELECT frequency_bucket AS frequency_bucket, previous_users AS previous_users,
  round(100.0 * previous_users / nullIf((SELECT count() FROM people), 0), 2) AS share_percent,
  returning_users AS returning_users, round(100.0 * returning_users / nullIf(previous_users, 0), 2) AS return_percent,
  toString(period_end - 56) AS previous_start, toString(period_end - 28) AS next_start,
  toString(period_end) AS exclusive_end
FROM totals
ORDER BY multiIf(frequency_bucket = '1 day', 1, frequency_bucket = '2–3 days', 2,
  frequency_bucket = '4–7 days', 3, frequency_bucket = '8+ days', 4, 5)`;
}

export function periodsQuery(sources: QuerySources = LIVE_SOURCES): string {
  return `WITH ${completedWindowEnd(sources)} AS period_end,
  people AS (
    SELECT person_id AS person_id,
      period_end - 28 * (1 + toInt(floor(dateDiff('day', activity_day, period_end - 1) / 28))) AS period_start,
      sum(app_views) AS app_views, sum(board_sends) AS board_sends, sum(ticks) AS ticks
    FROM ${sources.days}
    WHERE activity_day >= period_end - 168 AND activity_day < period_end
    GROUP BY person_id, period_start
    HAVING period_start >= toDate('${PRODUCTION_START}')
  )
SELECT period_start AS period_start, countIf(app_views > 0) AS app_active_users,
  countIf(board_sends > 0) AS board_active_users,
  countIf(board_sends > 0 AND ticks = 0) AS board_users_without_tick,
  round(100.0 * countIf(board_sends > 0 AND ticks = 0) / nullIf(countIf(board_sends > 0), 0), 2) AS without_tick_percent
FROM people GROUP BY period_start ORDER BY period_start`;
}

export function weightedRetentionQuery(sources: QuerySources = LIVE_SOURCES): string {
  return `WITH ${completedWindowEnd(sources)} AS period_end,
  people AS (
    SELECT person_id AS person_id,
      groupUniqArrayIf(activity_day, app_views > 0) AS app_days,
      groupUniqArrayIf(activity_day, board_sends > 0) AS board_days
    FROM ${sources.days} WHERE activity_day >= period_end - 168 AND activity_day < period_end GROUP BY person_id
  ), observations AS (
    SELECT period_end - 28 * offset AS next_end FROM (SELECT arrayJoin(range(5)) AS offset)
    WHERE period_end - 28 * offset - 56 >= toDate('${PRODUCTION_START}')
  )
SELECT next_end AS exclusive_end,
  countIf(arrayExists(day -> day >= next_end - 56 AND day < next_end - 28, board_days)) AS previous_board_users,
  countIf(arrayExists(day -> day >= next_end - 56 AND day < next_end - 28, board_days)
    AND arrayExists(day -> day >= next_end - 28 AND day < next_end, board_days)) AS returning_board_users,
  round(100.0 * returning_board_users / nullIf(previous_board_users, 0), 2) AS weighted_board_retention_percent,
  countIf(arrayExists(day -> day >= next_end - 56 AND day < next_end - 28, app_days)) AS previous_app_users,
  countIf(arrayExists(day -> day >= next_end - 56 AND day < next_end - 28, app_days)
    AND arrayExists(day -> day >= next_end - 28 AND day < next_end, app_days)) AS returning_app_users,
  round(100.0 * returning_app_users / nullIf(previous_app_users, 0), 2) AS app_retention_percent
FROM observations CROSS JOIN people GROUP BY next_end ORDER BY next_end`;
}

export function activationQuery(sources: QuerySources = LIVE_SOURCES): string {
  return `WITH people AS (SELECT * FROM ${sources.newcomers}),
  observations AS (
    SELECT person_id, registered_first28, ordered_board_days_first28, board_next28,
      acquired_day, computed_as_of, arrayJoin([28, 56]) AS required_days FROM people
  ), stages AS (SELECT arrayJoin(range(1, 7)) AS stage), counts AS (
    SELECT required_days, stage,
      countIf(acquired_day + required_days <= least(${sources.cutoff}, computed_as_of)) AS eligible_users,
      countIf(acquired_day + required_days <= least(${sources.cutoff}, computed_as_of)
        AND multiIf(stage = 1, true, stage = 2, registered_first28,
          stage = 3, ordered_board_days_first28 >= 1, stage = 4, ordered_board_days_first28 >= 2,
          stage = 5, ordered_board_days_first28 >= 4, ordered_board_days_first28 >= 4 AND board_next28)) AS users,
      countIf(acquired_day + required_days <= least(${sources.cutoff}, computed_as_of)
        AND multiIf(stage <= 2, true, stage = 3, registered_first28,
          stage = 4, ordered_board_days_first28 >= 1, stage = 5, ordered_board_days_first28 >= 2,
          ordered_board_days_first28 >= 4)) AS previous_stage_users
    FROM observations CROSS JOIN stages WHERE required_days = 56 OR stage <= 5
    GROUP BY required_days, stage
  )
SELECT if(required_days = 28, 'First 28 days (preview)', 'Full 56-day funnel') AS observation,
  multiIf(stage = 1, '1. First app screen', stage = 2, '2. Registration completed',
    stage = 3, '3. First successful board send', stage = 4, '4. Second board-active day',
    stage = 5, '5. Fourth board-active day', '6. Board-active again, days 28–55') AS stage,
  eligible_users AS eligible_users, users AS users,
  round(100.0 * users / nullIf(eligible_users, 0), 2) AS conversion_percent,
  round(100.0 * users / nullIf(previous_stage_users, 0), 2) AS previous_stage_conversion_percent,
  if(eligible_users = 0, 'Pending: no mature users', 'Complete observation windows') AS status
FROM counts ORDER BY required_days, stage`;
}

export function sourceQualityQuery(sources: QuerySources = LIVE_SOURCES): string {
  return `SELECT acquisition_source AS acquisition_source, count() AS new_users,
  countIf(acquired_day + 28 <= least(${sources.cutoff}, computed_as_of)) AS eligible_28d,
  countIf(acquired_day + 29 <= least(${sources.cutoff}, computed_as_of)) AS eligible_day28,
  countIf(acquired_day + 56 <= least(${sources.cutoff}, computed_as_of)) AS eligible_56d,
  countIf(acquired_day + 28 <= least(${sources.cutoff}, computed_as_of) AND registered_first28) AS registered_users,
  countIf(acquired_day + 28 <= least(${sources.cutoff}, computed_as_of) AND board_days_first28 >= 1) AS first_board_users,
  countIf(acquired_day + 28 <= least(${sources.cutoff}, computed_as_of) AND board_days_first28 >= 2) AS two_day_users,
  round(100.0 * registered_users / nullIf(eligible_28d, 0), 2) AS registration_percent,
  round(100.0 * first_board_users / nullIf(eligible_28d, 0), 2) AS first_board_percent,
  round(100.0 * two_day_users / nullIf(eligible_28d, 0), 2) AS two_day_percent,
  round(100.0 * countIf(acquired_day + 29 <= least(${sources.cutoff}, computed_as_of) AND board_day28) / nullIf(eligible_day28, 0), 2) AS board_day28_percent,
  round(100.0 * countIf(acquired_day + 56 <= least(${sources.cutoff}, computed_as_of) AND board_next28) / nullIf(eligible_56d, 0), 2) AS board_next28_percent,
  round(100.0 * countIf(acquired_day + 29 <= least(${sources.cutoff}, computed_as_of) AND app_day28) / nullIf(eligible_day28, 0), 2) AS app_day28_percent,
  round(100.0 * countIf(acquired_day + 56 <= least(${sources.cutoff}, computed_as_of) AND app_next28) / nullIf(eligible_56d, 0), 2) AS app_next28_percent,
  round(sumIf(board_days_first28, acquired_day + 28 <= least(${sources.cutoff}, computed_as_of)) / nullIf(eligible_28d, 0), 2) AS average_board_days,
  countIf(acquired_day + 28 <= least(${sources.cutoff}, computed_as_of) AND board_days_first28 = 0) AS no_successful_board_send,
  countIf(acquired_day + 28 <= least(${sources.cutoff}, computed_as_of) AND board_days_first28 = 0 AND first28_searches > 0) AS searched_without_send,
  countIf(acquired_day + 28 <= least(${sources.cutoff}, computed_as_of) AND board_days_first28 = 0 AND first28_connections > 0) AS connected_without_send
FROM ${sources.newcomers} GROUP BY acquisition_source ORDER BY new_users DESC`;
}

export function cohortRetentionQuery(kind: 'app' | 'board', sources: QuerySources = LIVE_SOURCES): string {
  return `WITH intervals AS (SELECT arrayJoin(range(6)) AS period),
  people AS (SELECT person_id, acquired_day, ${kind}_days AS activity_days, computed_as_of FROM ${sources.newcomers})
SELECT toStartOfWeek(acquired_day, 1) AS acquisition_week, period AS period,
  concat(toString(toStartOfWeek(acquired_day, 1)), ' · n=', toString(count())) AS cohort_label,
  count() AS cohort_size,
  countIf(acquired_day + (period + 1) * 28 <= least(${sources.cutoff}, computed_as_of)) AS eligible_users,
  countIf(acquired_day + (period + 1) * 28 <= least(${sources.cutoff}, computed_as_of)
    AND arrayExists(day -> day >= acquired_day + period * 28 AND day < acquired_day + (period + 1) * 28, activity_days)) AS retained_users,
  round(100.0 * retained_users / nullIf(eligible_users, 0), 2) AS retention_percent,
  if(eligible_users = 0, 'Pending', if(eligible_users < cohort_size, 'Partially mature cohort; eligible users only', 'Complete cohort')) AS status
FROM people CROSS JOIN intervals GROUP BY acquisition_week, period ORDER BY acquisition_week, period LIMIT 400`;
}

export function contributionQuery(sources: QuerySources = LIVE_SOURCES): string {
  return `WITH ${completedWindowEnd(sources)} AS period_end,
  people AS (SELECT person_id, toStartOfMonth(acquired_day) AS acquisition_month, acquisition_source FROM ${sources.newcomers}),
  days AS (
    SELECT *, period_end - 28 * (1 + toInt(floor(dateDiff('day', activity_day, period_end - 1) / 28))) AS period_start
    FROM ${sources.days} WHERE activity_day >= period_end - 168 AND activity_day < period_end
  ), period_totals AS (
    SELECT period_start, countIf(board_sends > 0) AS total_board_days,
      uniqExactIf(person_id, board_sends > 0) AS total_board_users
    FROM days GROUP BY period_start
  ), contributions AS (
    SELECT days.period_start AS period_start,
      if(people.acquisition_month IS NULL, 'Existing / unclassified', toString(people.acquisition_month)) AS acquisition_cohort,
      if(people.acquisition_month IS NULL, 'Existing / unclassified', people.acquisition_source) AS acquisition_source,
      uniqExactIf(days.person_id, board_sends > 0) AS board_active_users,
      countIf(board_sends > 0) AS board_active_days,
      sum(board_sends) AS climbs_sent, sum(ticks) AS logged_ticks,
      sum(grade_ratings) AS grade_ratings, sum(quality_ratings) AS quality_ratings,
      sum(published_creations) AS published_creation_events, sum(draft_creations) AS draft_creation_events,
      sum(unknown_creations) AS unknown_creation_events
    FROM days LEFT JOIN people ON toString(people.person_id) = toString(days.person_id)
    WHERE days.period_start >= toDate('${PRODUCTION_START}')
    GROUP BY days.period_start, acquisition_cohort, acquisition_source
  )
SELECT contributions.period_start AS period_start, toString(contributions.period_start + 28) AS exclusive_end,
  acquisition_cohort AS acquisition_cohort, acquisition_source AS acquisition_source,
  board_active_users AS board_active_users, board_active_days AS board_active_days,
  climbs_sent AS climbs_sent, logged_ticks AS logged_ticks,
  grade_ratings AS grade_ratings, quality_ratings AS quality_ratings,
  published_creation_events AS published_creation_events, draft_creation_events AS draft_creation_events,
  unknown_creation_events AS unknown_creation_events,
  round(100.0 * board_active_days / nullIf(total_board_days, 0), 2) AS share_board_days_percent,
  round(100.0 * board_active_users / nullIf(total_board_users, 0), 2) AS share_board_users_percent
FROM contributions JOIN period_totals ON period_totals.period_start = contributions.period_start
ORDER BY period_start DESC, board_active_days DESC LIMIT 500`;
}

/** A saved drill-down; campaign/country do not invent missing Apple Ads attribution. */
export function acquisitionBreakdownQuery(sources: QuerySources = LIVE_SOURCES): string {
  return `SELECT acquisition_source AS acquisition_source, first_campaign AS first_campaign,
  country AS country, platform AS platform, attribution_evidence AS attribution_evidence,
  count() AS new_users,
  countIf(acquired_day + 28 <= least(${sources.cutoff}, computed_as_of)) AS eligible_28d,
  countIf(acquired_day + 28 <= least(${sources.cutoff}, computed_as_of) AND board_days_first28 >= 2) AS two_day_users
FROM ${sources.newcomers}
GROUP BY acquisition_source, first_campaign, country, platform, attribution_evidence
ORDER BY new_users DESC LIMIT 500`;
}
