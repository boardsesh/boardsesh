import {
  activationQuery,
  acquisitionBreakdownQuery,
  bucketsQuery,
  cohortRetentionQuery,
  contributionQuery,
  DASHBOARD_ID,
  newcomersQuery,
  periodsQuery,
  personDaysQuery,
  sourceQualityQuery,
  weightedRetentionQuery,
} from './growth-queries';

type Column = {
  column: string;
  settings: { display: { label: string }; formatting?: { style: 'number'; decimalPlaces: number; suffix?: string } };
};

function column(columnName: string, label: string): Column {
  return {
    column: columnName,
    settings: {
      display: { label },
      ...(columnName.endsWith('_percent')
        ? { formatting: { style: 'number' as const, decimalPlaces: 2, suffix: '%' } }
        : {}),
    },
  };
}

function table(query: string, columns?: Column[], pinnedColumns?: string[]) {
  return {
    kind: 'DataVisualizationNode' as const,
    source: { kind: 'HogQLQuery' as const, query },
    display: 'ActionsTable' as const,
    ...(columns ? { tableSettings: { columns, pinnedColumns } } : {}),
  };
}

function line(query: string, xColumn: string, series: [string, string][]) {
  return {
    kind: 'DataVisualizationNode' as const,
    source: { kind: 'HogQLQuery' as const, query },
    display: 'ActionsLineGraph' as const,
    chartSettings: {
      xAxis: { column: xColumn },
      yAxis: series.map(([columnName, label]) => column(columnName, label)),
      showNullsAsZero: false,
      showLegend: true,
      showValuesOnSeries: true,
    },
  };
}

function retention(kind: 'app' | 'board') {
  return {
    ...line(cohortRetentionQuery(kind), 'period', [['retention_percent', 'Retention (%)']]),
    display: 'TwoDimensionalHeatmap' as const,
    chartSettings: {
      xAxis: { column: 'period' },
      yAxis: [column('retention_percent', 'Retention (%)')],
      seriesBreakdownColumn: 'cohort_label',
      showNullsAsZero: false,
      showLegend: true,
      xAxisLabel: '28-day period after first app screen (0 = acquisition period)',
    },
  };
}

export const growthDashboard = {
  dashboardId: DASHBOARD_ID,
  views: [
    {
      name: 'growth_native_person_days',
      id: '01a12475-5fee-0000-9293-ba3236630c06',
      query: personDaysQuery,
      sync_frequency: '24hour',
    },
    {
      name: 'growth_native_newcomers',
      id: '01a12476-b003-0000-66c1-6b897bdbb5bd',
      query: newcomersQuery,
      sync_frequency: '24hour',
    },
  ],
  updates: [
    {
      id: 12518191,
      name: 'Monthly active climbers (fixed 28-day periods)',
      description:
        'Native production; canonical people, internal cohort excluded. UTC windows anchored to 9 Oct 2026, complete periods only. App: ≥1 screen. Board: ≥1 successful send. Untagged legacy binaries excluded. Daily refreshed source.',
      query: line(periodsQuery(), 'period_start', [
        ['app_active_users', 'App-active people'],
        ['board_active_users', 'Board-active people'],
      ]),
    },
    {
      id: 12518193,
      name: 'Weighted retention: adjacent 28-day windows',
      description:
        'Returners ÷ all people active in the preceding 28 days. Separate app-screen and successful-board-send definitions. Each pair has non-overlapping, fully elapsed UTC windows; adjacent observations share one period. Coverage starts 25 July; first complete point ends 9 Oct. Counts available in SQL results.',
      query: line(weightedRetentionQuery(), 'exclusive_end', [
        ['weighted_board_retention_percent', 'Weighted board retention'],
        ['app_retention_percent', 'App retention'],
      ]),
    },
    {
      id: 12518194,
      name: 'Who comes back: board-day distribution',
      description:
        'Previous 28-day successful-send users, grouped by distinct UTC board days. Share denominator: all preceding board-active people. Return denominator: people in that bucket. Overall = sum(returners) / sum(previous users), not mean of bucket rates. Fixed UTC windows; exclusive ends shown.',
      query: table(
        bucketsQuery(),
        [
          column('frequency_bucket', 'Previous board-active days'),
          column('previous_users', 'Previous users'),
          column('share_percent', 'Share of board users'),
          column('returning_users', 'Returning users'),
          column('return_percent', 'Return rate'),
          column('previous_start', 'Previous start'),
          column('next_start', 'Next start'),
          column('exclusive_end', 'Exclusive end'),
        ],
        ['frequency_bucket'],
      ),
    },
    {
      id: 12518207,
      name: 'Lit a board, logged no tick (fixed 28-day periods)',
      description:
        'People with a successful board send and no Tick Logged in the same complete fixed 28-day UTC window. Percentage denominator: all board-active people in that window. Does not claim that climbers never log ticks. Same daily source as active and weighted-retention tiles.',
      query: line(periodsQuery(), 'period_start', [['without_tick_percent', 'Board users without a tick']]),
    },
  ],
  additions: [
    {
      key: 'activation',
      name: 'Newcomer activation: 28-day preview and 56-day funnel',
      description:
        'First-ever native newcomers since 7 Sep; identity artifacts and unverified Android builds excluded. Ordered registration → successful sends on distinct UTC days 0–27 → board return days 28–55. Common mature denominator per observation, plus prior-stage conversion. NULL = pending, not 0%.',
      query: table(
        activationQuery(),
        [
          column('observation', 'Observation'),
          column('stage', 'Stage'),
          column('eligible_users', 'Eligible users'),
          column('users', 'Users'),
          column('conversion_percent', 'First-open conversion'),
          column('previous_stage_conversion_percent', 'Previous-stage conversion'),
          column('status', 'Status'),
        ],
        ['observation', 'stage'],
      ),
    },
    {
      key: 'sources',
      name: 'Acquisition quality: first-touch sources',
      description:
        'All clean native newcomers; 28/29/56-day eligible denominators shown. Source outcomes independent of funnel registration. First28 board-day average includes zeros. Exact Day28 differs from days 28–55. Earliest verified acquisition touch only; unknown stays unknown. Organic App Store/Apple Ads unavailable.',
      query: table(sourceQualityQuery()),
    },
    {
      key: 'app-retention',
      name: 'Acquisition cohorts: app retention',
      description:
        'Weekly first-ever native acquisition cohorts; ≥1 screen per UTC 28-day age interval. Rows name full cohort size; SQL results also show eligible and retained users. Each denominator includes only people whose whole interval elapsed at source refresh. NULL cells are pending. Period0 includes first open.',
      query: retention('app'),
    },
    {
      key: 'board-retention',
      name: 'Acquisition cohorts: board retention',
      description:
        'Weekly first-ever native acquisition cohorts; ≥1 successful board send per UTC 28-day age interval. Rows name full cohort size; SQL results also show eligible and retained users. Each denominator includes only people whose whole interval elapsed at source refresh. NULL cells are pending.',
      query: retention('board'),
    },
    {
      key: 'contribution',
      name: 'Acquisition cohorts: engagement contribution',
      description:
        'Complete fixed 28 UTC periods, acquisition month/source. Canonical person-days, sends, committed ticks and hasDifficulty/hasQuality rating flags. Creation events separate published/draft/unknown. User/day shares of all board-active users/days; existing/unclassified included so totals reconcile. Not unique climb counts.',
      query: table(contributionQuery()),
    },
  ],
  drilldown: {
    name: 'Acquisition first touch: campaign and country detail',
    description:
      'Saved detail for the source-quality tile. Immutable acquisition-linked campaign, observed country, platform and evidence. No Apple Ads keyword/cost/attributed-install data currently. Two-day outcome denominator: mature first28 newcomers; not inferred from iOS.',
    query: table(acquisitionBreakdownQuery()),
  },
  retentionDetails: {
    name: 'Acquisition retention: eligible and retained cohort counts',
    description:
      'Exact denominators behind both acquisition heatmaps. Full cohort size, fully observed eligible people, retained people and percentage for each UTC28 age interval. App and successful-board-send definitions separate. Pending means zero eligible people, never 0% retention.',
    query: table(`SELECT app.acquisition_week AS acquisition_week, app.period AS period,
  app.cohort_size AS cohort_size, app.eligible_users AS eligible_users,
  app.retained_users AS app_retained_users, app.retention_percent AS app_retention_percent,
  board.retained_users AS board_retained_users, board.retention_percent AS board_retention_percent,
  app.status AS status
FROM (${cohortRetentionQuery('app')}) AS app
JOIN (${cohortRetentionQuery('board')}) AS board
  ON app.acquisition_week = board.acquisition_week AND app.period = board.period
ORDER BY app.acquisition_week, app.period LIMIT 400`),
  },
  modelHealth: {
    name: 'Growth models: observation cutoffs',
    description:
      'Daily source refresh observation boundaries. Compare these exclusive UTC dates before interpreting recent acquisition metrics. Fixed-period tiles use completed windows no later than the daily source cutoff; newcomer eligibility is capped at its own cutoff.',
    query: table(`SELECT 'Native person-days' AS model, count() AS rows,
  max(computed_as_of) AS observed_through_exclusive_utc FROM growth_native_person_days
UNION ALL SELECT 'Native newcomers', count(), max(computed_as_of) FROM growth_native_newcomers`),
  },
  paidAcquisitionBody: `## Apple Ads baseline: attribution and spend pending

Proposed budget: **A$500/month**. Actual spend, Apple-attributed installs/first opens and every acquisition cost are **unavailable**, not zero. iOS usage is never Apple Ads attribution. Organic App Store discovery is also currently unknown.

Keep three inputs separate: advertising spend in AUD; verified install/first-open attribution; canonical-person engagement outcomes. Play install referrers and identity-linked first web landings support today's source table. They do not identify Apple Ads users.

Once attribution is verified, report spend ÷ attributed installs, registrations, first successful board users, 2+ board-day users, and retained board users during days 28–55. Each outcome must use the same acquisition cohort and mature denominator. Exact Day28 is a separate product measure. First opens are not store installs.

Needed: Apple AdServices attribution linked to the original person, acquisition/campaign identifiers and timestamps; actual dated spend and currency; country/campaign/keyword dimensions where supplied. Compare later campaign interactions separately from the first touch. No cost calculation until spend and attributed acquisition are reliably joined.

Today's source-quality table includes known organic Google Play, Reddit/community where linked, other identifiable sources and direct/unknown. It cannot recover unattributed Reddit word of mouth. See the saved “Acquisition first touch: campaign and country detail” insight for supported breakdowns.

Board activity means a successful climb sent to an LED board. Browsing, successful connection alone and spray-wall activity are not that metric. The source table reports people without a successful send, including search-only and connection-only subcounts; this does not prove someone has never climbed.

[Eligible / retained cohort counts](https://us.posthog.com/project/412845/insights/4BQhqXOB) · [Campaign / country detail](https://us.posthog.com/project/412845/insights/ddw4wY4T) · [Observed-through dates](https://us.posthog.com/project/412845/insights/pkfI8ln2)

## Reading this dashboard

The initial retention baseline ends **9 Oct 2026**, advances every 28 days, and excludes periods before production tagging. Newcomer cohorts use UTC day0 at first screen; clean first-entry baseline starts **7 Sep 2026**. 28/29/56 full days are required for activation / exact Day28 / subsequent-period retention. Pending cohorts stay NULL. Both reusable views refresh daily and carry their observation cutoff; cached data never advances maturity.

Activity reports cover six fixed 28-day periods. The acquisition registry retains a bounded 365-day history, so fully matured six-period cohorts remain observable. Older/unclean people remain in the existing/unclassified contribution group. Extend the versioned history constant for longer comparisons.

Older 7-day newcomer and second-session tiles retain their original definitions. Use the new clean newcomer cohorts for acquisition comparisons. Native and www/browser metrics remain separate.`,
};
