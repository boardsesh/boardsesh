/**
 * HogQL behind the "Community: monthly recap" PostHog dashboard: the monthly
 * totals, the top 10 gyms and climbers, and a ready-to-paste Reddit post.
 * Contract: docs/growth-metrics.md, "Community monthly recap".
 *
 * The backend family `community-monthly-stats` re-sends every month it covers
 * with the same event uuid (daily for the current and last month, weekly for
 * thirteen). ClickHouse folds the copies together eventually, but until it
 * does both are visible, so every source below keeps only the newest copy of
 * each uuid.
 *
 * Each query is built from three sources so the same text can run against
 * literal fixture rows (community-fixtures.ts) and against live events.
 */

export const COMMUNITY_PROJECT_ID = 412845;
export const COMMUNITY_DASHBOARD_ID = 2254130;

const COMMUNITY_DISTINCT_ID = 'system:community-monthly';
const SUMMARY_EVENT = 'Community Monthly Summary';
const RANK_EVENT = 'Community Monthly Rank';

/** The weekly run covers thirteen calendar months; 420 days holds all of them. */
const LOOKBACK_DAYS = 420;

/**
 * `Active Users Snapshot` counts from `user_activity_days`, which began on
 * 2026-10-09. Its 30-day number covers a whole 30 days from this day on; the
 * Reddit post leaves the line out for any month that ends earlier.
 */
export const FIRST_FULL_MONTHLY_ACTIVE_DAY = '2026-11-07';

export interface CommunitySources {
  /** Columns: month, complete, climbers_who_lit, climbs_lit, sends_logged, climbers_who_logged, new_accounts, gyms_with_activity. */
  summary: string;
  /** Columns: month, complete, list, rank, is_empty, gym_name, gym_slug, climbers, climbs_lit, climber_name, sends, flashes, send_days. */
  ranks: string;
  /** Columns: day, monthly_active_users. */
  activeUsers: string;
}

function newestCopyPerUuid(eventName: string, distinctId: string, columns: string): string {
  return `SELECT ${columns}
    FROM events
    WHERE event = '${eventName}' AND distinct_id = '${distinctId}'
      AND timestamp >= now() - INTERVAL ${LOOKBACK_DAYS} DAY
    ORDER BY created_at DESC
    LIMIT 1 BY uuid`;
}

export const liveSources: CommunitySources = {
  summary: newestCopyPerUuid(
    SUMMARY_EVENT,
    COMMUNITY_DISTINCT_ID,
    `toString(properties.month) AS month,
      toString(properties.complete) = 'true' AS complete,
      toInt(properties.climbersWhoLit) AS climbers_who_lit,
      toInt(properties.climbsLit) AS climbs_lit,
      toInt(properties.sendsLogged) AS sends_logged,
      toInt(properties.climbersWhoLogged) AS climbers_who_logged,
      toInt(properties.newAccounts) AS new_accounts,
      toInt(properties.gymsWithActivity) AS gyms_with_activity`,
  ),
  ranks: newestCopyPerUuid(
    RANK_EVENT,
    COMMUNITY_DISTINCT_ID,
    `toString(properties.month) AS month,
      toString(properties.complete) = 'true' AS complete,
      toString(properties.list) AS list,
      toInt(properties.rank) AS rank,
      toString(properties.empty) = 'true' AS is_empty,
      ifNull(toString(properties.gymName), '') AS gym_name,
      ifNull(toString(properties.gymSlug), '') AS gym_slug,
      ifNull(toInt(properties.climbers), 0) AS climbers,
      ifNull(toInt(properties.climbsLit), 0) AS climbs_lit,
      ifNull(toString(properties.climberName), '') AS climber_name,
      ifNull(toInt(properties.sends), 0) AS sends,
      ifNull(toInt(properties.flashes), 0) AS flashes,
      ifNull(toInt(properties.sendDays), 0) AS send_days`,
  ),
  activeUsers: newestCopyPerUuid(
    'Active Users Snapshot',
    'system:active-users',
    `toString(properties.day) AS day, toInt(properties.monthlyActiveUsers) AS monthly_active_users`,
  ),
};

/** The CTEs every query starts from, plus `target`: the latest complete month. */
function withSources(sources: CommunitySources, body: string): string {
  return `WITH
  summary AS (${sources.summary}),
  ranks AS (${sources.ranks}),
  active_users AS (${sources.activeUsers}),
  target AS (SELECT max(month) AS month FROM summary WHERE complete)
${body}`;
}

/** 'YYYY-MM' of the month before `monthExpression` ('YYYY-MM'). */
function previousMonth(monthExpression: string): string {
  return `formatDateTime(addMonths(toDate(concat(${monthExpression}, '-01')), -1), '%Y-%m')`;
}

/** An integer with thousands separators: 61230 -> '61,230'. Covers values below a billion. */
function withThousands(expression: string): string {
  const group = (divisor: number) => `leftPad(toString(intDiv(${expression}, ${divisor}) % 1000), 3, '0')`;
  return `multiIf(
    ${expression} >= 1000000, concat(toString(intDiv(${expression}, 1000000)), ',', ${group(1000)}, ',', ${group(1)}),
    ${expression} >= 1000, concat(toString(intDiv(${expression}, 1000)), ',', ${group(1)}),
    toString(${expression}))`;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** 'October 2026' for '2026-10'. */
function monthTitle(monthExpression: string): string {
  const date = `toDate(concat(${monthExpression}, '-01'))`;
  const names = `[${MONTH_NAMES.map((name) => `'${name}'`).join(', ')}]`;
  return `concat(arrayElement(${names}, toMonth(${date})), ' ', toString(toYear(${date})))`;
}

/** Rank movement against last month's list, matched on `keyColumn`. */
function rankChange(currentRank: string, previousRank: string): string {
  return `multiIf(
    ifNull(${previousRank}, 0) = 0, 'new',
    ${previousRank} > ${currentRank}, concat('+', toString(${previousRank} - ${currentRank})),
    ${previousRank} < ${currentRank}, concat('-', toString(${currentRank} - ${previousRank})),
    'same')`;
}

/** One row per month: people. The current month is labelled "(so far)". */
export function monthlyPeopleQuery(sources: CommunitySources = liveSources): string {
  return withSources(
    sources,
    `SELECT
    if(complete, month, concat(month, ' (so far)')) AS month_label,
    climbers_who_lit,
    climbers_who_logged,
    new_accounts
  FROM summary
  ORDER BY month`,
  );
}

/** One row per month: climbs. The current month is labelled "(so far)". */
export function monthlyClimbsQuery(sources: CommunitySources = liveSources): string {
  return withSources(
    sources,
    `SELECT
    if(complete, month, concat(month, ' (so far)')) AS month_label,
    climbs_lit,
    sends_logged
  FROM summary
  ORDER BY month`,
  );
}

/** The top 10 gyms of the latest complete month, with movement since the month before. */
export function topGymsQuery(sources: CommunitySources = liveSources): string {
  const gymKey = `if(gym_slug = '', gym_name, gym_slug)`;
  return withSources(
    sources,
    `SELECT
    this_month.rank AS rank,
    this_month.gym_name AS gym,
    this_month.climbers AS climbers,
    this_month.climbs_lit AS climbs_lit,
    ${rankChange('this_month.rank', 'last_month.rank')} AS vs_last_month,
    if(this_month.gym_slug = '', '', concat('https://boardsesh.com/gym/', this_month.gym_slug)) AS link,
    (SELECT month FROM target) AS month
  FROM (
    SELECT rank, gym_name, gym_slug, climbers, climbs_lit, ${gymKey} AS gym_key
    FROM ranks
    WHERE list = 'gyms' AND NOT is_empty AND month = (SELECT month FROM target)
  ) AS this_month
  LEFT JOIN (
    SELECT rank, ${gymKey} AS gym_key
    FROM ranks
    WHERE list = 'gyms' AND NOT is_empty AND month = ${previousMonth('(SELECT month FROM target)')}
  ) AS last_month ON last_month.gym_key = this_month.gym_key
  ORDER BY rank`,
  );
}

/**
 * The top 10 climbers of the latest complete month. A climber the backend did
 * not name (anonymous on other people's boards) reads "Anonymous climber" and
 * has no movement, since nothing can match them across months.
 */
export function topClimbersQuery(sources: CommunitySources = liveSources): string {
  return withSources(
    sources,
    `SELECT
    this_month.rank AS rank,
    if(this_month.climber_name = '', 'Anonymous climber', this_month.climber_name) AS climber,
    this_month.sends AS sends,
    this_month.flashes AS flashes,
    this_month.send_days AS days_with_a_send,
    if(this_month.climber_name = '', '', ${rankChange('this_month.rank', 'last_month.rank')}) AS vs_last_month,
    (SELECT month FROM target) AS month
  FROM (
    SELECT rank, climber_name, sends, flashes, send_days
    FROM ranks
    WHERE list = 'climbers' AND NOT is_empty AND month = (SELECT month FROM target)
  ) AS this_month
  LEFT JOIN (
    SELECT rank, climber_name
    FROM ranks
    WHERE list = 'climbers' AND NOT is_empty AND climber_name != ''
      AND month = ${previousMonth('(SELECT month FROM target)')}
  ) AS last_month ON last_month.climber_name = this_month.climber_name
  ORDER BY rank`,
  );
}

/**
 * One markdown block for the monthly r/kilterboard post, for the latest
 * complete month. Totals and per-gym numbers only: nothing here splits
 * Boardsesh climbers by board brand, and nothing may be added that does.
 */
export function redditPostQuery(sources: CommunitySources = liveSources): string {
  const litChange = `if(ifNull(last_month.climbs_lit, 0) > 0,
      concat(' (', if(this_month.climbs_lit >= last_month.climbs_lit, '+', ''),
        toString(round((this_month.climbs_lit - last_month.climbs_lit) * 100 / last_month.climbs_lit)), '% on last month)'),
      '')`;
  const gymLine = `concat(toString(tupleElement(entry, 1)), '. ',
      if(tupleElement(entry, 3) = '', tupleElement(entry, 2),
        concat('[', tupleElement(entry, 2), '](https://boardsesh.com/gym/', tupleElement(entry, 3), ')')),
      ': ', ${withThousands('tupleElement(entry, 4)')}, ' climbers')`;
  const climberLine = `concat(toString(tupleElement(entry, 1)), '. ',
      if(tupleElement(entry, 2) = '', 'Anonymous climber', tupleElement(entry, 2)),
      ': ', ${withThousands('tupleElement(entry, 3)')}, ' sends')`;
  return withSources(
    sources,
    `SELECT arrayStringConcat(arrayFilter(line -> line IS NOT NULL, [
    concat('**Boardsesh in ', ${monthTitle('this_month.month')}, '**'),
    '',
    concat('- ', ${withThousands('this_month.climbers_who_lit')}, ' climbers lit ',
      ${withThousands('this_month.climbs_lit')}, ' climbs on their boards', ${litChange}),
    concat('- ', ${withThousands('this_month.sends_logged')}, ' sends logged'),
    concat('- Climbers were active at ', ${withThousands('this_month.gyms_with_activity')}, ' gyms'),
    concat('- ', ${withThousands('this_month.new_accounts')}, ' new climbers joined'),
    if(this_month.last_day >= '${FIRST_FULL_MONTHLY_ACTIVE_DAY}' AND ifNull(month_end.users, 0) > 0,
      concat('- ', ${withThousands('month_end.users')}, ' climbers used Boardsesh in the last 30 days'),
      NULL),
    '',
    '**Busiest gyms** (climbers who lit a climb there)',
    (SELECT arrayStringConcat(arrayMap(entry -> ${gymLine},
        arraySort(entry -> tupleElement(entry, 1), groupArray((rank, gym_name, gym_slug, climbers)))), '\\n')
      FROM ranks WHERE list = 'gyms' AND NOT is_empty AND rank <= 5 AND month = (SELECT month FROM target)),
    '',
    '**Most sends logged**',
    (SELECT arrayStringConcat(arrayMap(entry -> ${climberLine},
        arraySort(entry -> tupleElement(entry, 1), groupArray((rank, climber_name, sends)))), '\\n')
      FROM ranks WHERE list = 'climbers' AND NOT is_empty AND rank <= 5 AND month = (SELECT month FROM target))
  ]), '\\n') AS reddit_post
  FROM (
    SELECT *, toString(toLastDayOfMonth(toDate(concat(month, '-01')))) AS last_day
    FROM summary
    WHERE month = (SELECT month FROM target)
  ) AS this_month
  LEFT JOIN summary AS last_month ON last_month.month = ${previousMonth('this_month.month')}
  LEFT JOIN (
    SELECT day, max(monthly_active_users) AS users FROM active_users GROUP BY day
  ) AS month_end ON month_end.day = this_month.last_day`,
  );
}

export const communityQueries = {
  monthlyPeople: monthlyPeopleQuery,
  monthlyClimbs: monthlyClimbsQuery,
  topGyms: topGymsQuery,
  topClimbers: topClimbersQuery,
  redditPost: redditPostQuery,
} as const;
