/** Apple report rows and consented people are separate populations. See docs/growth-metrics.md. */
import { SHARED_EVENTS } from '../../packages/shared/analytics/src/events';

export const APPLE_ADS_DASHBOARD_ID = 2192729;
export const APPLE_ADS_PROJECT_ID = 412845;
export const MEASUREMENT_RELEASE = '2.7.0';
const INSTALL_ATTRIBUTED = 'Install Attributed';

export interface AppleAdsQueryWindow {
  from: string;
  to: string;
  /** Exclusive UTC observation cutoff, independent of cohort-entry selection. */
  cutoff: string;
}

/** SQL sources expose only normalized columns, so fixtures execute the production calculation. */
export interface AppleAdsQuerySources {
  campaignRows: string;
  keywordRows: string;
  people: string;
  activity: string;
  observedPeople: string;
  registrations: string;
  newcomers: string;
  nativeFreshness: string;
  modelFreshness: string;
}

export const APPLE_ADS_WINDOW: AppleAdsQueryWindow = {
  from: '{filters.dateRange.from}',
  to: '{filters.dateRange.to}',
  cutoff: "toDateTime(toDate(toTimeZone(now(), 'UTC')))",
};

/** Calendar reports include a selected partial final day; an exact midnight stays exclusive. */
export function appleAdsReportingRange(window: AppleAdsQueryWindow, column = 'date') {
  const reportEnd = `least(${window.to}, ${window.cutoff})`;
  const exclusiveReportDay = `if(toDateTime(toDate(${reportEnd})) = ${reportEnd},
    toDate(${reportEnd}), toDate(${reportEnd}) + INTERVAL 1 DAY)`;
  return `${column} >= toString(toDate(greatest(${window.from}, ${window.cutoff} - INTERVAL 365 DAY)))
    AND ${column} < toString(${exclusiveReportDay})`;
}

function bounds(window: AppleAdsQueryWindow) {
  return `least(${window.to}, ${window.cutoff}) AS entry_end,
  greatest(${window.from}, ${window.cutoff} - INTERVAL 365 DAY) AS entry_start,
  ${window.cutoff} AS observation_end`;
}

export function liveAppleAdsSources(window: AppleAdsQueryWindow = APPLE_ADS_WINDOW): AppleAdsQuerySources {
  const native = `properties.$lib = 'posthog-react-native'
    AND properties.environment = 'production' AND properties.$os = 'iOS'
    AND person_id NOT IN COHORT 295337`;
  const reportingRange = appleAdsReportingRange(window);
  return {
    campaignRows: `SELECT date AS report_day, toString(campaign_id) AS campaign_id, name AS campaign_name,
      toString(local_spend.currency) AS currency, toFloat(local_spend.amount) AS spend,
      impressions, taps, total_installs AS installs, total_new_downloads AS new_downloads,
      total_redownloads AS redownloads, tap_installs, view_installs
    FROM applesearchads.campaign_report WHERE ${reportingRange}`,
    keywordRows: `SELECT date AS report_day, toString(campaign_id) AS campaign_id,
      toString(ad_group_id) AS ad_group_id, toString(keyword_id) AS keyword_id,
      text AS keyword, match_type, toString(local_spend.currency) AS currency,
      toFloat(local_spend.amount) AS spend, impressions, taps, total_installs AS installs,
      total_new_downloads AS new_downloads, total_redownloads AS redownloads, tap_installs, view_installs
    FROM applesearchads.keyword_report WHERE ${reportingRange}`,
    people: `SELECT toString(id) AS person_id, is_identified,
      coalesce(nullIf(toString(properties.apple_ads_campaign_id), ''), 'Unknown') AS campaign_id,
      coalesce(nullIf(toString(properties.apple_ads_keyword_id), ''), 'Unknown') AS keyword_id,
      coalesce(nullIf(toString(properties.apple_ads_country_or_region), ''), 'Unknown') AS country,
      coalesce(nullIf(toString(properties.apple_ads_conversion_type), ''), 'Unknown') AS conversion_type,
      coalesce(nullIf(toString(properties.apple_ads_claim_type), ''), 'Unknown') AS claim_type
    FROM persons WHERE properties.attribution_provider = 'apple_ads'
      AND properties.apple_ads_attribution_status = 'attributed' AND id NOT IN COHORT 295337`,
    activity: `SELECT toString(person_id) AS person_id, toString(uuid) AS event_uuid,
      event, timestamp, toString(properties.boardType) AS board_type,
      toString(properties.boardName) AS board_name, toString(properties.trigger) AS trigger,
      toString(properties.$app_version) AS app_version,
      toString(properties.provider) AS provider, toString(properties.ota_update_id) AS ota_update_id
    FROM events WHERE timestamp >= greatest(${window.from}, ${window.cutoff} - INTERVAL 365 DAY)
      AND timestamp < ${window.cutoff} AND ${native}
      AND event IN ('$screen', '${INSTALL_ATTRIBUTED}', '${SHARED_EVENTS.SignupCompleted}',
        '${SHARED_EVENTS.LoginAttempted}', '${SHARED_EVENTS.LoginSucceeded}', '${SHARED_EVENTS.ClimbSentToBoardSuccess}',
        '${SHARED_EVENTS.BoardCreated}', '${SHARED_EVENTS.WallTaken}', '${SHARED_EVENTS.SetActiveClimb}', '${SHARED_EVENTS.TickLogged}')`,
    observedPeople: `SELECT toString(person_id) AS person_id FROM events
    WHERE timestamp >= greatest(${window.from}, ${window.cutoff} - INTERVAL 365 DAY)
      AND timestamp < least(${window.to}, ${window.cutoff}) AND ${native}
      AND person_id IN (SELECT id FROM persons WHERE properties.attribution_provider = 'apple_ads'
        AND properties.apple_ads_attribution_status = 'attributed')
    GROUP BY person_id`,
    registrations: `SELECT toString(person_id) AS person_id, toString(uuid) AS event_uuid, timestamp
    FROM events WHERE timestamp >= ${window.cutoff} - INTERVAL 365 DAY
      AND timestamp < ${window.cutoff} AND ${native} AND event = '${SHARED_EVENTS.SignupCompleted}'`,
    newcomers: `SELECT person_id, acquired_at, entry_version, computed_as_of
      FROM growth_native_newcomers WHERE platform = 'iOS'
      AND acquired_at >= greatest(${window.from}, ${window.cutoff} - INTERVAL 365 DAY)
      AND acquired_at < least(${window.to}, ${window.cutoff})`,
    nativeFreshness: `SELECT maxOrNull(timestamp) AS latest_native_event_utc FROM events
      WHERE timestamp >= now() - INTERVAL 1 DAY AND timestamp < now() AND ${native}`,
    modelFreshness: 'SELECT maxOrNull(computed_as_of) AS model_cutoff FROM growth_native_newcomers',
  };
}

function warehouseRows(sources: AppleAdsQuerySources, keyword = false) {
  const dimensions = keyword ? ', ad_group_id, keyword_id, keyword, match_type' : '';
  return `report_rows AS (${keyword ? sources.keywordRows : sources.campaignRows}),
  ${keyword ? '' : 'campaign_labels AS (SELECT campaign_id, argMax(campaign_name, report_day) AS campaign_name FROM report_rows GROUP BY campaign_id),'}
  distinct_reports AS (
    SELECT DISTINCT report_day, campaign_id${dimensions}, currency, spend, impressions, taps,
      installs, new_downloads, redownloads, tap_installs, view_installs
    FROM report_rows WHERE currency IS NOT NULL AND currency != '' AND spend IS NOT NULL
  ),
  daily_reports AS (
    SELECT report_day, campaign_id${dimensions}, currency, count() AS versions,
      max(spend) AS spend, max(impressions) AS impressions, max(taps) AS taps,
      max(installs) AS installs, max(new_downloads) AS new_downloads,
      max(redownloads) AS redownloads, max(tap_installs) AS tap_installs, max(view_installs) AS view_installs
    FROM distinct_reports GROUP BY report_day, campaign_id${dimensions}, currency
  )`;
}

function deliveryColumns() {
  return `count() AS reporting_days, min(report_day) AS first_report_day, max(report_day) AS last_report_day,
  countIf(versions > 1) AS conflicting_daily_rows,
  if(max(versions) > 1, NULL, sum(daily_reports.spend)) AS spend,
  if(max(versions) > 1 OR countIf(daily_reports.impressions IS NULL) > 0, NULL, sum(daily_reports.impressions)) AS impressions,
  if(max(versions) > 1 OR countIf(daily_reports.taps IS NULL) > 0, NULL, sum(daily_reports.taps)) AS taps,
  if(max(versions) > 1 OR countIf(daily_reports.installs IS NULL) > 0, NULL, sum(daily_reports.installs)) AS installs,
  if(max(versions) > 1 OR countIf(daily_reports.new_downloads IS NULL) > 0, NULL, sum(daily_reports.new_downloads)) AS new_downloads,
  if(max(versions) > 1 OR countIf(daily_reports.redownloads IS NULL) > 0, NULL, sum(daily_reports.redownloads)) AS redownloads,
  if(max(versions) > 1 OR countIf(daily_reports.tap_installs IS NULL) > 0, NULL, sum(daily_reports.tap_installs)) AS tap_installs,
  if(max(versions) > 1 OR countIf(daily_reports.view_installs IS NULL) > 0, NULL, sum(daily_reports.view_installs)) AS view_installs,
  round(spend / nullIf(installs, 0), 4) AS cost_per_reported_install,
  round(spend / nullIf(tap_installs, 0), 4) AS cost_per_tap_install,
  round(spend / nullIf(taps, 0), 4) AS cost_per_tap,
  round(100.0 * taps / nullIf(impressions, 0), 2) AS tap_through_percent,
  round(100.0 * view_installs / nullIf(installs, 0), 2) AS view_install_percent`;
}

export function appleAdsDeliveryQuery(
  sources = liveAppleAdsSources(),
  interval: 'total' | 'day' | 'week' = 'total',
  limit: number | null = 500,
) {
  const period =
    interval === 'total'
      ? ''
      : interval === 'day'
        ? 'report_day AS period, '
        : 'toStartOfWeek(toDate(report_day), 1) AS period, ';
  return `WITH ${warehouseRows(sources)}
SELECT ${period}daily_reports.campaign_id AS campaign_id, any(campaign_labels.campaign_name) AS campaign_name, currency, ${deliveryColumns()}
FROM daily_reports LEFT ANY JOIN campaign_labels ON daily_reports.campaign_id = campaign_labels.campaign_id
GROUP BY ${interval === 'total' ? '' : 'period, '}daily_reports.campaign_id, currency
${limit === null ? '' : `ORDER BY ${interval === 'total' ? '' : 'period, '}campaign_id, currency LIMIT ${limit}`}`;
}

export function appleAdsKeywordQuery(sources = liveAppleAdsSources(), limit: number | null = 200) {
  return `WITH ${warehouseRows(sources, true)}
SELECT campaign_id, ad_group_id, keyword_id, keyword, match_type, currency, ${deliveryColumns()}
FROM daily_reports GROUP BY campaign_id, ad_group_id, keyword_id, keyword, match_type, currency
${limit === null ? '' : `ORDER BY spend DESC, campaign_id, keyword_id LIMIT ${limit}`}`;
}

export function appleAdsUnmappedSpendQuery(sources = liveAppleAdsSources()) {
  return `WITH campaigns AS (${appleAdsDeliveryQuery(sources, 'total', null)}),
  keywords AS (${appleAdsKeywordQuery(sources, null)}),
  named AS (SELECT campaign_id, currency, sum(spend) AS named_keyword_spend,
    sum(conflicting_daily_rows) AS conflicting_keyword_rows FROM keywords GROUP BY campaign_id, currency)
SELECT campaigns.campaign_id AS campaign_id, campaigns.currency AS currency,
  campaigns.spend AS campaign_spend, coalesce(named.named_keyword_spend, 0) AS named_keyword_spend,
  if(coalesce(named.conflicting_keyword_rows, 0) > 0, NULL,
    campaigns.spend - coalesce(named.named_keyword_spend, 0)) AS unmapped_spend,
  'Unmapped to named keyword rows; source is not inferred' AS interpretation
FROM campaigns LEFT JOIN named ON campaigns.campaign_id = named.campaign_id AND campaigns.currency = named.currency
ORDER BY campaign_id, currency LIMIT 100`;
}

function peopleCtes(sources: AppleAdsQuerySources, window: AppleAdsQueryWindow) {
  return `${bounds(window)},
  attributed_people AS (${sources.people}), activity AS (${sources.activity}),
  selected_activity AS (SELECT * FROM activity WHERE timestamp >= entry_start AND timestamp < entry_end),
  observed_people AS (${sources.observedPeople}),
  current_cohort AS (
    SELECT attributed_people.* FROM attributed_people
    WHERE person_id IN (SELECT person_id FROM observed_people)
  )`;
}

export function appleAdsCoverageQuery(sources = liveAppleAdsSources(), window = APPLE_ADS_WINDOW) {
  return `WITH ${peopleCtes(sources, window)},
  facts AS (SELECT person_id, countIf(event = '$screen') AS screens,
    countIf(event = '${SHARED_EVENTS.SignupCompleted}') AS signup_events,
    minOrNullIf(timestamp, event = '${INSTALL_ATTRIBUTED}') AS first_attribution_observed_at
    FROM selected_activity GROUP BY person_id)
SELECT current_cohort.campaign_id AS campaign_id, current_cohort.conversion_type AS conversion_type,
  current_cohort.claim_type AS claim_type, count() AS attributed_people,
  countIf(NOT current_cohort.is_identified) AS unidentified_people,
  countIf(coalesce(facts.screens, 0) = 0) AS without_captured_screen,
  countIf(current_cohort.keyword_id = 'Unknown') AS unknown_keyword_people,
  countIf(current_cohort.country = 'Unknown') AS unknown_country_people,
  countIf(coalesce(facts.signup_events, 0) > 0) AS observed_signup_people,
  min(facts.first_attribution_observed_at) AS first_attribution_observed_at,
  'Observed attribution is not an install timestamp; signup capture before the verified fix is incomplete' AS interpretation
FROM current_cohort LEFT JOIN facts ON current_cohort.person_id = facts.person_id
GROUP BY campaign_id, conversion_type, claim_type ORDER BY campaign_id, conversion_type, claim_type LIMIT 100`;
}

/** Outcomes use exact elapsed time from the validated first-ever native screen, not calendar-day age. */
export function appleAdsOutcomesQuery(
  sources = liveAppleAdsSources(),
  window = APPLE_ADS_WINDOW,
  breakdown: 'campaign' | 'keyword' | 'country' = 'campaign',
) {
  const dimension = breakdown === 'campaign' ? 'campaign_id' : breakdown === 'keyword' ? 'keyword_id' : 'country';
  return `WITH ${bounds(window)}, attributed_people AS (${sources.people}),
  newcomer_rows AS (${sources.newcomers}), activity AS (${sources.activity}),
  clean_cohort AS (
    SELECT newcomer_rows.person_id AS person_id, newcomer_rows.acquired_at AS acquired_at,
      newcomer_rows.entry_version AS entry_version,
      least(observation_end, toDateTime(newcomer_rows.computed_as_of)) AS observed_before,
      attributed_people.campaign_id AS campaign_id, attributed_people.${dimension} AS dimension,
      attributed_people.conversion_type AS conversion_type, attributed_people.claim_type AS claim_type
    FROM newcomer_rows INNER JOIN attributed_people ON newcomer_rows.person_id = attributed_people.person_id
    WHERE newcomer_rows.acquired_at >= entry_start AND newcomer_rows.acquired_at < entry_end
      AND newcomer_rows.acquired_at < least(observation_end, toDateTime(newcomer_rows.computed_as_of))
  ),
  facts AS (
    SELECT person_id,
      groupUniqArrayIf(timestamp, event = '${SHARED_EVENTS.ClimbSentToBoardSuccess}') AS send_times,
      groupUniqArrayIf(timestamp, (event = '${SHARED_EVENTS.BoardCreated}' AND board_type = 'spray')
        OR (event = '${SHARED_EVENTS.WallTaken}' AND board_name = 'spray')) AS spray_start_times,
      groupUniqArrayIf(timestamp, board_type = 'spray' AND (event = '${SHARED_EVENTS.TickLogged}'
        OR (event = '${SHARED_EVENTS.SetActiveClimb}' AND (trigger IS NULL OR trigger = 'put_on_wall')))) AS spray_action_times
    FROM activity WHERE person_id IN (SELECT person_id FROM clean_cohort) GROUP BY person_id
  ),
  registration_rows AS (${sources.registrations}),
  signup_facts AS (SELECT person_id, groupUniqArray(timestamp) AS signup_times FROM registration_rows
    WHERE person_id IN (SELECT person_id FROM clean_cohort) GROUP BY person_id),
  outcomes AS (
    SELECT clean_cohort.*,
      arrayExists(action_at -> action_at < observed_before, signup_facts.signup_times) AS signup_observed,
      acquired_at + INTERVAL 7 DAY <= observed_before AS mature7,
      acquired_at + INTERVAL 14 DAY <= observed_before AS mature14,
      acquired_at + INTERVAL 28 DAY <= observed_before AS mature28,
      acquired_at + INTERVAL 56 DAY <= observed_before AS mature56,
      arrayExists(action_at -> action_at >= acquired_at AND action_at < acquired_at + INTERVAL 7 DAY
        AND action_at < observed_before, facts.send_times) AS board_first7,
      arrayExists(start_at -> start_at >= acquired_at AND start_at < acquired_at + INTERVAL 7 DAY
        AND start_at < observed_before AND arrayExists(action_at -> action_at >= start_at
          AND action_at < acquired_at + INTERVAL 7 DAY AND action_at < observed_before, facts.spray_action_times),
        facts.spray_start_times) AS spray_first7,
      length(arrayDistinct(arrayMap(action_at -> toDate(toString(toTimeZone(action_at, 'UTC'))),
        arrayFilter(action_at -> action_at >= acquired_at AND action_at < acquired_at + INTERVAL 28 DAY
          AND action_at < observed_before, facts.send_times)))) >= 2 AS board_two_days_first28,
      arrayExists(action_at -> action_at >= acquired_at + INTERVAL 7 DAY
        AND action_at < acquired_at + INTERVAL 14 DAY AND action_at < observed_before, facts.send_times) AS board_days7_13,
      arrayExists(action_at -> action_at >= acquired_at + INTERVAL 28 DAY
        AND action_at < acquired_at + INTERVAL 56 DAY AND action_at < observed_before, facts.send_times) AS board_days28_55
    FROM clean_cohort LEFT JOIN facts ON clean_cohort.person_id = facts.person_id
    LEFT JOIN signup_facts ON clean_cohort.person_id = signup_facts.person_id
  )
SELECT campaign_id, dimension, conversion_type, claim_type, count() AS clean_newcomers,
  countIf(signup_observed) AS observed_signup_people,
  countIf(mature7) AS eligible_7d, countIf(mature7 AND board_first7) AS board_active_7d,
  round(100.0 * board_active_7d / nullIf(eligible_7d, 0), 2) AS board_activation_7d_percent,
  countIf(mature7 AND spray_first7) AS spray_active_7d,
  round(100.0 * spray_active_7d / nullIf(eligible_7d, 0), 2) AS spray_activation_7d_percent,
  countIf(mature14) AS eligible_14d, countIf(mature14 AND board_days7_13) AS returned_days7_13,
  round(100.0 * returned_days7_13 / nullIf(eligible_14d, 0), 2) AS return_days7_13_percent,
  countIf(mature28) AS eligible_28d, countIf(mature28 AND board_two_days_first28) AS two_board_days_28d,
  round(100.0 * two_board_days_28d / nullIf(eligible_28d, 0), 2) AS two_board_days_28d_percent,
  countIf(mature56) AS eligible_56d, countIf(mature56 AND board_days28_55) AS returned_days28_55,
  round(100.0 * returned_days28_55 / nullIf(eligible_56d, 0), 2) AS return_days28_55_percent,
  min(observed_before) AS observed_before_utc,
  'Observed outcomes; signup measurement awaits verified 2.7.0 release' AS measurement_status
FROM outcomes GROUP BY campaign_id, dimension, conversion_type, claim_type
ORDER BY campaign_id, dimension, conversion_type, claim_type LIMIT 200`;
}

export function appleAdsFreshnessQuery(sources = liveAppleAdsSources()) {
  return `WITH report_rows AS (${sources.campaignRows}), native_freshness AS (${sources.nativeFreshness}),
  model_freshness AS (${sources.modelFreshness})
SELECT 'Apple reporting day (timezone unverified)' AS source, toString(maxOrNull(report_day)) AS latest_observation,
  'Reporting dates remain separate from UTC person windows' AS interpretation FROM report_rows WHERE currency IS NOT NULL
UNION ALL SELECT 'Native production iOS event (UTC)', toString(maxOrNull(latest_native_event_utc)),
  'Latest event in the last 24 hours' FROM native_freshness
UNION ALL SELECT 'Clean newcomer model (exclusive UTC cutoff)', toString(maxOrNull(model_cutoff)),
  'Outcome maturity never advances past this source cutoff' FROM model_freshness`;
}

/** Custom integrity check: zero success with observed board use is a telemetry warning, not login failure. */
export function appleAdsAuthQualityQuery(sources = liveAppleAdsSources(), window = APPLE_ADS_WINDOW) {
  return `WITH ${bounds(window)}, activity AS (${sources.activity})
SELECT coalesce(nullIf(app_version, ''), 'Unknown') AS app_version,
  coalesce(nullIf(ota_update_id, ''), 'Embedded / unknown') AS ota_update_id,
  uniqExactIf(person_id, event = '${SHARED_EVENTS.LoginAttempted}') AS login_attempters,
  uniqExactIf(person_id, event = '${SHARED_EVENTS.LoginSucceeded}') AS login_success_people,
  uniqExactIf(person_id, event = '${SHARED_EVENTS.SignupCompleted}') AS signup_people,
  uniqExactIf(person_id, event = '${SHARED_EVENTS.ClimbSentToBoardSuccess}') AS board_active_people,
  max(timestamp) AS latest_event_utc,
  multiIf(app_version = '2.6.0', 'Known incomplete auth measurement; do not infer signup conversion',
    login_attempters > 0 AND login_success_people = 0 AND board_active_people > 0,
    'Auth-success measurement gap; investigate before interpreting conversion',
    app_version = '${MEASUREMENT_RELEASE}', 'Awaiting verified release evidence', 'Observed events; coverage not certified') AS measurement_status
FROM activity WHERE timestamp >= entry_start AND timestamp < entry_end
  AND event IN ('${SHARED_EVENTS.LoginAttempted}', '${SHARED_EVENTS.LoginSucceeded}',
    '${SHARED_EVENTS.SignupCompleted}', '${SHARED_EVENTS.ClimbSentToBoardSuccess}')
GROUP BY app_version, ota_update_id
ORDER BY (app_version = '${MEASUREMENT_RELEASE}') DESC, latest_event_utc DESC, app_version, ota_update_id LIMIT 500`;
}

/** Native runner handles these simple event counts; compound integrity checks above require SQL. */
export const appleAdsAuthTrendsQuery = {
  kind: 'TrendsQuery' as const,
  series: [SHARED_EVENTS.LoginAttempted, SHARED_EVENTS.LoginSucceeded, SHARED_EVENTS.SignupCompleted].map((event) => ({
    kind: 'EventsNode' as const,
    event,
    math: 'dau' as const,
  })),
  dateRange: { date_from: '-28dStart' },
  interval: 'day' as const,
  filterTestAccounts: true,
  properties: [
    { key: '$lib', type: 'event' as const, operator: 'exact' as const, value: ['posthog-react-native'] },
    { key: 'environment', type: 'event' as const, operator: 'exact' as const, value: ['production'] },
    { key: '$os', type: 'event' as const, operator: 'exact' as const, value: ['iOS'] },
  ],
  trendsFilter: { display: 'ActionsTable' as const },
  breakdownFilter: {
    breakdowns: ['$app_version', 'provider', 'ota_update_id'].map((property) => ({ property, type: 'event' as const })),
    breakdown_limit: 25,
  },
};
