/** Observed, consented www sessions; never a count of installs or all Google visitors. */
export interface SeoObservationWindow {
  /** Inclusive UTC timestamp, as a SQL expression. */
  from: string;
  /** Exclusive UTC timestamp, as a SQL expression. */
  to: string;
}

export const SEO_OBSERVATION_WINDOW: SeoObservationWindow = {
  from: '{filters.dateRange.from}',
  to: '{filters.dateRange.to}',
};

import { APP_GUIDE_SLUGS, AURORA_BRAND_SLUGS } from '../../packages/web/app/lib/seo/app-guide-model';

/** The published English guide routes, derived from the same slugs the pages are built from. */
export const APP_GUIDE_PATHS = [
  '/apps',
  ...APP_GUIDE_SLUGS.map((slug) => `/apps/${slug}` as const),
  '/compare/spray-wall-apps',
] as const;

/**
 * Retired guide URLs and the live page they 308 to. The five Aurora brand guides
 * merged into /apps/aurora; a landing recorded on an old URL (pre-merge history,
 * or a client that captured before following the redirect) counts as the page
 * that replaced it.
 */
export const RETIRED_APP_GUIDE_PATHS: Readonly<Record<string, (typeof APP_GUIDE_PATHS)[number]>> = Object.fromEntries(
  AURORA_BRAND_SLUGS.map((brand) => [`/apps/${brand}`, '/apps/aurora']),
);

const sqlString = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** entry_path -> its live guide, or 'existing site'. */
function landingGroup(): string {
  const retired = Object.entries(RETIRED_APP_GUIDE_PATHS).flatMap(([from, to]) => [
    `entry_path = ${sqlString(from)}`,
    sqlString(to),
  ]);
  const live = `entry_path IN (${APP_GUIDE_PATHS.map(sqlString).join(', ')})`;
  return `multiIf(${[...retired, live, 'entry_path', "'existing site'"].join(', ')})`;
}

/** Select only fields needed by the session calculation, with a bounded entry lookback. */
function capturedEvents(window: SeoObservationWindow): string {
  return `SELECT person_id, coalesce(toString(properties.$session_id), '') AS session_id,
    event, timestamp, coalesce(toString(properties.$current_url), '') AS url,
    coalesce(toString(properties.$raw_user_agent), '') AS ua,
    lower(coalesce(toString(properties.$referring_domain), '')) AS referring_domain,
    coalesce(toString(properties.$geoip_country_code), '') AS country,
    lower(coalesce(toString(properties.utm_medium), '')) AS medium,
    coalesce(properties.$virt_is_bot, false) AS known_bot
  FROM events
  WHERE timestamp >= ${window.from} - INTERVAL 1 DAY AND timestamp < ${window.to}
    AND event IN ('$pageview', 'App Install Click', 'Web App Opened')
    AND properties.$lib = 'js'
    AND match(coalesce(toString(properties.$current_url), ''), '^https://(www[.])?boardsesh[.]com(/|$)')
    AND person_id NOT IN COHORT 295337`;
}

/** Session attribution shared by Google and AI referrals; classify before filtering referrers. */
function capturedSessionCtes(sourceQuery: string, deterministicEntry = false): string {
  // Capture cannot establish chronology within an exact timestamp tie. A stable
  // tuple order keeps every landing field from the same deterministic pageview.
  const entryOrder = deterministicEntry
    ? 'tuple(timestamp, url, referring_domain, country, medium, www_events.person_id, ua)'
    : 'timestamp';
  return `WITH www_events AS (${sourceQuery}),
  www_people AS (
    SELECT person_id, countIf(event = '$pageview') AS pageviews,
      countIf(event = 'App Install Click') AS store_clicks,
      argMinIf(ua, ${entryOrder}, event = '$pageview') AS entry_ua,
      argMinIf(referring_domain, ${entryOrder}, event = '$pageview') AS entry_referring_domain,
      argMinIf(country, ${entryOrder}, event = '$pageview') AS entry_country,
      max(known_bot) AS known_bot
    FROM www_events GROUP BY person_id HAVING pageviews > 0
  ),
  crawler_classes AS (
    SELECT person_id, multiIf(
      known_bot, 'known bot',
      entry_ua ILIKE '%Lightpanda%', 'lightpanda',
      entry_ua ILIKE '%Android SDK built%', 'emulator',
      pageviews = 1 AND entry_referring_domain ILIKE '%boardsesh.com%'
        AND entry_ua LIKE '%Windows NT%' AND match(entry_ua, 'Chrome/15[0-9]'), 'windows crawler, arm 1',
      pageviews = 1 AND entry_referring_domain ILIKE '%boardsesh.com%', 'other self-referred single page',
      entry_ua LIKE '%Windows NT%' AND match(entry_ua, 'Chrome/15[0-9]') AND entry_country = 'US'
        AND pageviews <= 2, 'unverified Windows automation',
      'kept') AS crawler_class
    FROM www_people
  ),
  session_facts AS (
    SELECT session_id, argMinIf(person_id, ${entryOrder}, event = '$pageview') AS person_id,
      minIf(timestamp, event = '$pageview') AS landed_at,
      argMinIf(url, ${entryOrder}, event = '$pageview') AS entry_url,
      argMinIf(referring_domain, ${entryOrder}, event = '$pageview') AS entry_referrer,
      argMinIf(country, ${entryOrder}, event = '$pageview') AS entry_country,
      argMinIf(medium, ${entryOrder}, event = '$pageview') AS entry_medium,
      countIf(event = 'App Install Click') AS store_clicks,
      maxIf(timestamp, event = 'App Install Click') AS last_store_click,
      countIf(event = 'Web App Opened') AS web_opens,
      maxIf(timestamp, event = 'Web App Opened') AS last_web_open
    FROM www_events WHERE notEmpty(session_id)
    GROUP BY session_id HAVING countIf(event = '$pageview') > 0
  )`;
}

/**
 * The injected source is for executable synthetic fixtures, never a browser input.
 * A session is counted once, and outcomes must follow its first observed pageview.
 * Existing-site landings remain in the result so guide traffic cannot hide redistribution.
 */
export function seoAppGuideSessionsQuery(
  window: SeoObservationWindow = SEO_OBSERVATION_WINDOW,
  sourceQuery: string = capturedEvents(window),
): string {
  return `${capturedSessionCtes(sourceQuery)},
  search_sessions AS (
    SELECT session_facts.*, crawler_classes.crawler_class AS crawler_class,
      replaceRegexpOne(extract(entry_url, '^https://[^/]+([^?#]*)'), '/$', '') AS entry_path
    FROM session_facts LEFT JOIN crawler_classes ON session_facts.person_id = crawler_classes.person_id
    WHERE landed_at >= ${window.from} AND landed_at < ${window.to}
      AND match(entry_referrer, '^(www[.])?google[.](com|[a-z]{2}|com[.][a-z]{2}|co[.][a-z]{2})$')
      AND entry_medium IN ('', 'organic')
      AND NOT match(entry_url, '(?i)[?&](gclid|dclid|gbraid|wbraid|msclkid|fbclid|rdt_cid)=')
      AND NOT match(entry_url, '(?i)[?&]utm_medium=(cpc|ppc|paid[^&#]*|display|social|email)(&|#|$)')
  )
SELECT ${landingGroup()} AS landing_group,
  if(entry_country = 'US', 'US', 'outside US or unknown') AS geography,
  countIf(crawler_class IN ('kept', 'unverified Windows automation')) AS landing_sessions,
  countIf(crawler_class IN ('kept', 'unverified Windows automation') AND store_clicks > 0 AND last_store_click >= landed_at) AS store_clicking_sessions,
  countIf(crawler_class IN ('kept', 'unverified Windows automation') AND web_opens > 0 AND last_web_open >= landed_at) AS web_opening_sessions,
  countIf(crawler_class IN ('kept', 'unverified Windows automation') AND ((store_clicks > 0 AND last_store_click >= landed_at)
    OR (web_opens > 0 AND last_web_open >= landed_at))) AS action_sessions,
  countIf(crawler_class NOT IN ('kept', 'unverified Windows automation')) AS excluded_crawler_sessions,
  countIf(crawler_class = 'unverified Windows automation') AS possible_automation_sessions
FROM search_sessions
GROUP BY landing_group, geography
ORDER BY landing_group, geography LIMIT 50`;
}

/** Exact human referral hosts; crawler user agents are measured at the edge separately. */
export const AI_SEARCH_REFERRAL_HOSTS = ['chatgpt.com', 'perplexity.ai', 'claude.ai'] as const;

/**
 * First observed www pageview per session, with one day of entry lookback.
 * Only guide landings count: visiting a guide later in an existing session is not acquisition.
 * Blank referrers and absent session IDs cannot be attributed and are excluded.
 */
export function seoAppGuideAiReferralsQuery(
  window: SeoObservationWindow = SEO_OBSERVATION_WINDOW,
  sourceQuery: string = capturedEvents(window),
): string {
  return `${capturedSessionCtes(sourceQuery, true)},
  ai_sessions AS (
    SELECT session_facts.*, crawler_classes.crawler_class AS crawler_class,
      replaceRegexpOne(extract(entry_url, '^https://[^/]+([^?#]*)'), '/$', '') AS entry_path
    FROM session_facts LEFT JOIN crawler_classes ON session_facts.person_id = crawler_classes.person_id
    WHERE landed_at >= ${window.from} AND landed_at < ${window.to}
      AND entry_referrer IN (${AI_SEARCH_REFERRAL_HOSTS.map(sqlString).join(', ')})
      AND entry_medium IN ('', 'organic', 'referral')
      AND NOT match(entry_url, '(?i)[?&](gclid|dclid|gbraid|wbraid|msclkid|fbclid|rdt_cid)=')
      AND NOT match(entry_url, '(?i)[?&]utm_medium=(cpc|ppc|paid[^&#]*|display|social|email)(&|#|$)')
  ),
  guide_sessions AS (
    SELECT *, ${landingGroup()} AS landing_group FROM ai_sessions
  )
SELECT entry_referrer AS referral_host, landing_group,
  countIf(crawler_class IN ('kept', 'unverified Windows automation')) AS landing_sessions,
  countIf(crawler_class NOT IN ('kept', 'unverified Windows automation')) AS excluded_crawler_sessions,
  countIf(crawler_class = 'unverified Windows automation') AS possible_automation_sessions
FROM guide_sessions WHERE landing_group != 'existing site'
GROUP BY referral_host, landing_group
ORDER BY referral_host, landing_group LIMIT 50`;
}
