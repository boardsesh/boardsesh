/**
 * Paid social (Reddit, Instagram/Meta) landing on www.boardsesh.com, store clicks and Android installs.
 * www landing traffic is anonymous, so it is keyed by session; Android installs are person properties.
 * See docs/growth-metrics.md, "Paid social (Reddit, Instagram)".
 */
import { SHARED_EVENTS } from '../../packages/shared/analytics/src/events';

export const PAID_SOCIAL_PROJECT_ID = 412845;
export const INTERNAL_COHORT_ID = 295337;
/** `App Install Click` (`APP_INSTALL_CLICK_EVENT` in packages/web/app/lib/app-install-event.ts). */
export const APP_INSTALL_CLICK = 'App Install Click';
/** Lower-cased sources. `meta` is what a bare `fbclid` (no `utm_source`) resolves to. */
export const PAID_SOCIAL_SOURCES = ['reddit', 'instagram', 'meta'] as const;

export interface PaidSocialWindow {
  from: string;
  to: string;
  /** Exclusive UTC observation cutoff for person outcomes. */
  cutoff: string;
}

export const PAID_SOCIAL_WINDOW: PaidSocialWindow = {
  from: '{filters.dateRange.from}',
  to: '{filters.dateRange.to}',
  cutoff: "toDateTime(toDate(toTimeZone(now(), 'UTC')))",
};

function sourceList(sources: readonly string[]) {
  return sources.map((source) => `'${source.replaceAll("'", "''")}'`).join(', ');
}

/** HogQL treats `NULL != ''` as true, so presence is always `notEmpty(coalesce(…, ''))`. */
function present(expression: string) {
  return `notEmpty(coalesce(${expression}, ''))`;
}

/** A click id is present as an event property (once www sends it) or on the landing URL itself. */
function hasClickId(name: 'rdt_cid' | 'fbclid') {
  return `(${present(`toString(properties.${name})`)}
        OR ${present(`extract(toString(properties.$current_url), '[?&]${name}=([^&#]*)')`)})`;
}

/** The session's first pageview URL carried a landing tag: later page loads only replay it. */
export const TAGGED_LANDING_URL = '[?&](utm_source|rdt_cid|fbclid)=';

/**
 * The landing tags of one www event. An explicit `utm_source` wins; a bare `rdt_cid` reads as
 * reddit / paid-social and a bare `fbclid` as meta / social, the fallbacks the store links use.
 * Every value is coalesced to '' so argMin over a session never meets a NULL.
 */
function landingTags() {
  const utmSource = 'trim(toString(properties.utm_source))';
  const hasUtm = present(utmSource);
  const hasRdt = hasClickId('rdt_cid');
  const hasFbclid = hasClickId('fbclid');
  const tag = (name: string) => `coalesce(trim(toString(properties.${name})), '')`;
  return `multiIf(${hasUtm}, lower(${utmSource}), ${hasRdt}, 'reddit', ${hasFbclid}, 'meta', '') AS source,
      multiIf(${hasUtm}, lower(${tag('utm_medium')}), ${hasRdt}, 'paid-social', ${hasFbclid}, 'social', '') AS medium,
      if(${hasUtm}, ${tag('utm_campaign')}, '') AS campaign,
      if(${hasUtm}, ${tag('utm_content')}, '') AS content`;
}

/**
 * www sessions that landed on a paid-social tag, with each person's crawler class.
 * The crawler rule is docs/growth-metrics.md "The www crawler rule", per person over the same window.
 */
function wwwCtes(window: PaidSocialWindow, sources: readonly string[]) {
  return `www_events AS (
    SELECT person_id, toString(properties.$session_id) AS session_id, event, timestamp,
      ${landingTags()},
      coalesce(toString(properties.$current_url), '') AS url,
      lower(coalesce(toString(properties.platform), '')) AS platform,
      coalesce(toString(properties.$raw_user_agent), '') AS ua,
      coalesce(toString(properties.$referring_domain), '') AS referring_domain,
      coalesce(toString(properties.$geoip_country_code), '') AS country
    FROM events
    WHERE timestamp >= ${window.from} AND timestamp < least(${window.to}, now())
      AND properties.$lib = 'js' AND event IN ('$pageview', '${APP_INSTALL_CLICK}')
      AND person_id NOT IN COHORT ${INTERNAL_COHORT_ID}
  ),
  www_people AS (
    SELECT person_id, countIf(event = '$pageview') AS pageviews,
      countIf(event = '${APP_INSTALL_CLICK}') AS store_clicks,
      argMinIf(ua, timestamp, event = '$pageview') AS entry_ua,
      argMinIf(referring_domain, timestamp, event = '$pageview') AS entry_referring_domain,
      argMinIf(country, timestamp, event = '$pageview') AS entry_country
    FROM www_events GROUP BY person_id HAVING pageviews > 0
  ),
  crawler_classes AS (
    SELECT person_id, multiIf(
      entry_ua ILIKE '%Lightpanda%', 'lightpanda',
      entry_ua ILIKE '%Android SDK built%', 'emulator',
      pageviews = 1 AND entry_referring_domain ILIKE '%boardsesh.com%'
        AND entry_ua LIKE '%Windows NT%' AND match(entry_ua, 'Chrome/15[0-9]'), 'windows crawler, arm 1',
      pageviews = 1 AND entry_referring_domain ILIKE '%boardsesh.com%', 'other self-referred single page',
      entry_ua LIKE '%Windows NT%' AND match(entry_ua, 'Chrome/15[0-9]') AND entry_country = 'US'
        AND pageviews <= 2 AND store_clicks = 0, 'windows crawler, arm 2',
      'kept') AS crawler_class
    FROM www_people
  ),
  landing_sessions AS (
    SELECT session_id, argMinIf(person_id, timestamp, event = '$pageview') AS person_id,
      minIf(timestamp, event = '$pageview') AS landed_at,
      argMinIf(url, timestamp, event = '$pageview') AS entry_url,
      argMinIf(source, timestamp, event = '$pageview') AS source,
      argMinIf(medium, timestamp, event = '$pageview') AS medium,
      argMinIf(campaign, timestamp, event = '$pageview') AS campaign,
      argMinIf(content, timestamp, event = '$pageview') AS content
    FROM www_events WHERE ${present('session_id')}
    GROUP BY session_id HAVING countIf(event = '$pageview') > 0
  ),
  paid_sessions AS (
    SELECT landing_sessions.session_id AS session_id, landing_sessions.person_id AS person_id,
      toDate(toTimeZone(landing_sessions.landed_at, 'UTC')) AS day, landing_sessions.source AS source,
      if(${present('landing_sessions.medium')}, landing_sessions.medium, '(none)') AS medium,
      if(${present('landing_sessions.campaign')}, landing_sessions.campaign, '(none)') AS campaign,
      if(${present('landing_sessions.content')}, landing_sessions.content, '(none)') AS content,
      coalesce(nullIf(crawler_classes.crawler_class, ''), 'kept') AS crawler_class
    FROM landing_sessions LEFT JOIN crawler_classes ON landing_sessions.person_id = crawler_classes.person_id
    WHERE landing_sessions.source IN (${sourceList(sources)})
      AND match(landing_sessions.entry_url, '${TAGGED_LANDING_URL}')
  ),
  kept_sessions AS (SELECT * FROM paid_sessions WHERE crawler_class = 'kept'),
  session_clicks AS (
    SELECT session_id, count() AS clicks, countIf(platform = 'ios') AS ios_clicks,
      countIf(platform = 'android') AS android_clicks
    FROM www_events WHERE event = '${APP_INSTALL_CLICK}' AND ${present('session_id')}
      AND session_id IN (SELECT session_id FROM kept_sessions)
    GROUP BY session_id
  )`;
}

/** Tile 1: crawler-filtered landing sessions per UTC day, source, medium and campaign. */
export function paidSocialLandingQuery(window = PAID_SOCIAL_WINDOW, sources: readonly string[] = PAID_SOCIAL_SOURCES) {
  return `WITH ${wwwCtes(window, sources)}
SELECT day, source, medium, campaign,
  countIf(crawler_class = 'kept') AS landing_sessions,
  uniqExactIf(person_id, crawler_class = 'kept') AS landing_visitors,
  countIf(crawler_class = 'windows crawler, arm 2') AS arm2_sessions_removed,
  countIf(crawler_class NOT IN ('kept', 'windows crawler, arm 2')) AS crawler_sessions_removed
FROM paid_sessions
GROUP BY day, source, medium, campaign
ORDER BY day DESC, landing_sessions DESC, source, medium, campaign LIMIT 500`;
}

/**
 * Tile 2: www store clicks inside those sessions. A session counts once in clicking_sessions however
 * many buttons it tapped; ios/android columns split the same sessions by store, so they can overlap.
 */
export function paidSocialStoreClicksQuery(
  window = PAID_SOCIAL_WINDOW,
  sources: readonly string[] = PAID_SOCIAL_SOURCES,
) {
  return `WITH ${wwwCtes(window, sources)}
SELECT kept_sessions.day AS day, kept_sessions.source AS source, kept_sessions.medium AS medium,
  kept_sessions.campaign AS campaign, count() AS landing_sessions,
  countIf(coalesce(session_clicks.clicks, 0) > 0) AS clicking_sessions,
  round(100.0 * clicking_sessions / nullIf(landing_sessions, 0), 2) AS click_through_percent,
  sum(coalesce(session_clicks.clicks, 0)) AS store_clicks,
  sum(coalesce(session_clicks.ios_clicks, 0)) AS ios_clicks,
  countIf(coalesce(session_clicks.ios_clicks, 0) > 0) AS ios_clicking_sessions,
  round(100.0 * ios_clicking_sessions / nullIf(landing_sessions, 0), 2) AS ios_click_through_percent,
  sum(coalesce(session_clicks.android_clicks, 0)) AS android_clicks,
  countIf(coalesce(session_clicks.android_clicks, 0) > 0) AS android_clicking_sessions,
  round(100.0 * android_clicking_sessions / nullIf(landing_sessions, 0), 2) AS android_click_through_percent
FROM kept_sessions LEFT JOIN session_clicks ON kept_sessions.session_id = session_clicks.session_id
GROUP BY day, source, medium, campaign
ORDER BY day DESC, landing_sessions DESC, source, medium, campaign LIMIT 500`;
}

/** Tile 3: per ad (`utm_content`) over the whole range. */
export function paidSocialAdsQuery(window = PAID_SOCIAL_WINDOW, sources: readonly string[] = PAID_SOCIAL_SOURCES) {
  return `WITH ${wwwCtes(window, sources)}
SELECT kept_sessions.source AS source, kept_sessions.medium AS medium, kept_sessions.campaign AS campaign,
  kept_sessions.content AS ad, count() AS landing_sessions,
  countIf(coalesce(session_clicks.clicks, 0) > 0) AS clicking_sessions,
  round(100.0 * clicking_sessions / nullIf(landing_sessions, 0), 2) AS click_through_percent,
  sum(coalesce(session_clicks.clicks, 0)) AS store_clicks,
  min(kept_sessions.day) AS first_day, max(kept_sessions.day) AS last_day
FROM kept_sessions LEFT JOIN session_clicks ON kept_sessions.session_id = session_clicks.session_id
GROUP BY source, medium, campaign, ad
ORDER BY landing_sessions DESC, source, medium, campaign, ad LIMIT 500`;
}

/**
 * Android people whose Play referrer named a paid-social source, with the install time Play reported.
 * `install_*` are current person properties written once per install.
 */
function androidInstallsCte(sources: readonly string[]) {
  const referrer = 'toString(properties.install_referrer_raw)';
  return `attributed_installs AS (
    SELECT toString(id) AS person_id,
      lower(coalesce(trim(toString(properties.install_source)), '')) AS source,
      if(${present('toString(properties.install_medium)')}, lower(toString(properties.install_medium)), '(none)') AS medium,
      if(${present('toString(properties.install_campaign)')}, toString(properties.install_campaign), '(none)') AS campaign,
      if(${present(`extract(${referrer}, 'utm_content=([^&]*)')`)}, extract(${referrer}, 'utm_content=([^&]*)'), '(none)') AS link_id,
      if(coalesce(toInt(toString(properties.install_begin_timestamp)), 0) > 0,
        fromUnixTimestamp(toInt(toString(properties.install_begin_timestamp))), NULL) AS installed_at
    FROM persons
    WHERE lower(coalesce(trim(toString(properties.install_source)), '')) IN (${sourceList(sources)})
      AND id NOT IN COHORT ${INTERNAL_COHORT_ID}
  )`;
}

/**
 * Tile 4: new Android installs per Play install day. People with no install time (an older install
 * that read the referrer late, or Play returned 0) are one all-time row, never a dated install.
 */
export function paidSocialAndroidInstallsQuery(
  window = PAID_SOCIAL_WINDOW,
  sources: readonly string[] = PAID_SOCIAL_SOURCES,
) {
  return `WITH ${androidInstallsCte(sources)}
SELECT if(installed_at IS NULL, 'install time unknown (all time)', toString(toDate(toTimeZone(installed_at, 'UTC')))) AS install_day,
  source, medium, campaign, link_id, count() AS people
FROM attributed_installs
WHERE installed_at IS NULL OR (installed_at >= ${window.from} AND installed_at < least(${window.to}, ${window.cutoff}))
GROUP BY install_day, source, medium, campaign, link_id
ORDER BY install_day DESC, people DESC, source, medium, campaign, link_id LIMIT 500`;
}

/**
 * Tile 5: sign-ups and 7-day board activation for those installs. Activation reuses the Apple Ads
 * outcome definition: a clean first-ever native newcomer (growth_native_newcomers, Android), entry
 * in range, a `Climb Sent to Board Success` within 7 days of the first screen, and maturity capped
 * at the registry's own cutoff.
 */
export function paidSocialAndroidOutcomesQuery(
  window = PAID_SOCIAL_WINDOW,
  sources: readonly string[] = PAID_SOCIAL_SOURCES,
) {
  const native = `properties.$lib = 'posthog-react-native' AND properties.environment = 'production'
      AND properties.$os = 'Android' AND person_id NOT IN COHORT ${INTERNAL_COHORT_ID}`;
  return `WITH least(${window.to}, ${window.cutoff}) AS entry_end, ${window.from} AS entry_start,
  ${window.cutoff} AS observation_end,
  ${androidInstallsCte(sources)},
  range_installs AS (SELECT * FROM attributed_installs
    WHERE installed_at >= entry_start AND installed_at < entry_end),
  signups AS (
    SELECT toString(person_id) AS person_id, min(timestamp) AS first_signup_at FROM events
    WHERE event = '${SHARED_EVENTS.SignupCompleted}' AND timestamp >= entry_start - INTERVAL 1 HOUR
      AND timestamp < observation_end AND ${native}
      AND toString(person_id) IN (SELECT person_id FROM range_installs)
    GROUP BY person_id
  ),
  newcomers AS (
    SELECT range_installs.person_id AS person_id, growth_native_newcomers.acquired_at AS acquired_at,
      least(observation_end, toDateTime(growth_native_newcomers.computed_as_of)) AS observed_before
    FROM growth_native_newcomers INNER JOIN range_installs
      ON growth_native_newcomers.person_id = range_installs.person_id
    WHERE growth_native_newcomers.platform = 'Android'
      AND growth_native_newcomers.acquired_at >= entry_start AND growth_native_newcomers.acquired_at < entry_end
      AND growth_native_newcomers.acquired_at < least(observation_end, toDateTime(growth_native_newcomers.computed_as_of))
  ),
  sends AS (
    SELECT toString(person_id) AS person_id, groupUniqArray(timestamp) AS send_times FROM events
    WHERE event = '${SHARED_EVENTS.ClimbSentToBoardSuccess}' AND timestamp >= entry_start
      AND timestamp < observation_end AND ${native}
      AND toString(person_id) IN (SELECT person_id FROM newcomers)
    GROUP BY person_id
  ),
  outcomes AS (
    SELECT newcomers.person_id AS person_id,
      newcomers.acquired_at + INTERVAL 7 DAY <= newcomers.observed_before AS mature7,
      arrayExists(sent_at -> sent_at >= newcomers.acquired_at AND sent_at < newcomers.acquired_at + INTERVAL 7 DAY
        AND sent_at < newcomers.observed_before, sends.send_times) AS board_first7
    FROM newcomers LEFT JOIN sends ON newcomers.person_id = sends.person_id
  )
SELECT range_installs.source AS source, range_installs.medium AS medium, range_installs.campaign AS campaign,
  count() AS new_installs,
  countIf(signups.first_signup_at IS NOT NULL
    AND signups.first_signup_at >= range_installs.installed_at - INTERVAL 1 HOUR) AS signup_people_so_far,
  countIf(range_installs.installed_at + INTERVAL 7 DAY <= observation_end) AS signup_eligible_7d,
  countIf(range_installs.installed_at + INTERVAL 7 DAY <= observation_end AND signups.first_signup_at IS NOT NULL
    AND signups.first_signup_at >= range_installs.installed_at - INTERVAL 1 HOUR
    AND signups.first_signup_at < range_installs.installed_at + INTERVAL 7 DAY) AS signup_7d,
  round(100.0 * signup_7d / nullIf(signup_eligible_7d, 0), 2) AS signup_7d_percent,
  countIf(outcomes.person_id IS NOT NULL AND ${present('outcomes.person_id')}) AS clean_newcomers,
  countIf(outcomes.mature7) AS eligible_7d,
  countIf(outcomes.mature7 AND outcomes.board_first7) AS board_active_7d,
  round(100.0 * board_active_7d / nullIf(eligible_7d, 0), 2) AS board_activation_7d_percent
FROM range_installs
LEFT JOIN signups ON range_installs.person_id = signups.person_id
LEFT JOIN outcomes ON range_installs.person_id = outcomes.person_id
GROUP BY source, medium, campaign
ORDER BY new_installs DESC, source, medium, campaign LIMIT 200`;
}
