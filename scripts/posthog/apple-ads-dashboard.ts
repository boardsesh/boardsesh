import {
  APPLE_ADS_DASHBOARD_ID,
  APPLE_ADS_PROJECT_ID,
  appleAdsAuthQualityQuery,
  appleAdsAuthTrendsQuery,
  appleAdsCoverageQuery,
  appleAdsDeliveryQuery,
  appleAdsFreshnessQuery,
  appleAdsKeywordQuery,
  appleAdsOutcomesQuery,
  appleAdsUnmappedSpendQuery,
} from './apple-ads-queries';

type Column = {
  column: string;
  settings: {
    formatting?: { style: 'number'; decimalPlaces: number; suffix?: string };
  };
};

function column(name: string): Column {
  const percent = name.endsWith('_percent');
  const money = name.startsWith('cost_') || name.endsWith('spend');
  return {
    column: name,
    settings:
      percent || money
        ? { formatting: { style: 'number' as const, decimalPlaces: 2, ...(percent ? { suffix: '%' } : {}) } }
        : {},
  };
}

const deliveryColumns = [
  column('campaign_name'),
  column('currency'),
  column('spend'),
  column('installs'),
  column('cost_per_reported_install'),
  column('tap_installs'),
  column('cost_per_tap_install'),
  column('new_downloads'),
  column('redownloads'),
  column('view_install_percent'),
  column('taps'),
  column('cost_per_tap'),
  column('tap_through_percent'),
  column('impressions'),
  column('view_installs'),
  column('campaign_id'),
  column('reporting_days'),
  column('first_report_day'),
  column('last_report_day'),
  column('conflicting_daily_rows'),
];

function outcomeColumns() {
  return [
    column('campaign_id'),
    column('dimension'),
    column('conversion_type'),
    column('claim_type'),
    column('clean_newcomers'),
    column('eligible_7d'),
    column('board_active_7d'),
    column('board_activation_7d_percent'),
    column('spray_active_7d'),
    column('spray_activation_7d_percent'),
    column('eligible_28d'),
    column('two_board_days_28d'),
    column('two_board_days_28d_percent'),
    column('eligible_14d'),
    column('returned_days7_13'),
    column('return_days7_13_percent'),
    column('eligible_56d'),
    column('returned_days28_55'),
    column('return_days28_55_percent'),
    column('observed_signup_people'),
    column('observed_before_utc'),
    column('measurement_status'),
  ];
}

function table(query: string, columns?: Column[]) {
  return {
    kind: 'DataVisualizationNode' as const,
    source: { kind: 'HogQLQuery' as const, query, filters: { dateRange: { date_from: '-28dStart' } } },
    display: 'ActionsTable' as const,
    ...(columns ? { tableSettings: { columns } } : {}),
  };
}

export const appleAdsDashboard = {
  projectId: APPLE_ADS_PROJECT_ID,
  dashboardId: APPLE_ADS_DASHBOARD_ID,
  name: 'Apple Ads to Active Climbers',
  description:
    'Apple campaign delivery, consenting attributed people, and their observed climbing outcomes. Coverage checks identify incomplete tracking; all-source iOS charts remain a separate baseline.',
  filters: { date_from: '-28dStart' },
  intro: {
    tileId: 13378282,
    body: `### Apple Ads: delivery, people and climbing
Read store delivery and consented product outcomes separately. Apple reports installs after taps and impressions; an attributed PostHog person is not a store install or proof of incremental growth.

**Signup measurement on 2.6.0 is incomplete.** The 2.7.0 repair is awaiting verified release evidence. Missing signup events are not failed signups. Rates with no mature cohort stay pending.

The range selects Apple reporting dates and native activity/cohort entry. Store report timezone is unverified; person windows use UTC. Attribution lookup time is not installation time. Unknown keyword/country stays unknown.`,
    agentContext:
      'Sources: dotted applesearchads warehouse tables; current persons attribution joined to canonical native production iOS person IDs; growth_native_newcomers membership. Internal cohort 295337 excluded. Do not use event-time person properties to filter earlier outcomes. Definitions are versioned in scripts/posthog/apple-ads-queries.ts and docs/growth-metrics.md; no approved Data Catalog metric exists. Never divide store spend by consenting-person outcomes as campaign CPA. Measurement release remains unverified until release-mode evidence is recorded.',
  },
  freshness: {
    id: 12710552,
    name: 'Measurement sources and observation cutoffs',
    description:
      'Store reporting day, latest native event, and exclusive clean-cohort source cutoff. Different clocks stay explicit.',
    query: table(appleAdsFreshnessQuery()),
  },
  additions: [
    {
      key: 'delivery',
      name: 'Apple delivery: spend, taps and installs',
      description:
        'Apple reporting rows by campaign and currency. Tap/view installs and new/redownloads stay separate. Duplicate rows deduplicate; contradictory daily versions suppress totals.',
      query: table(appleAdsDeliveryQuery(), deliveryColumns),
    },
    {
      key: 'delivery-weekly',
      name: 'Apple delivery by reporting week',
      description:
        'Monday reporting-week totals and costs; range-edge weeks can be partial. These are store dates, not UTC acquisition cohorts.',
      query: table(appleAdsDeliveryQuery(undefined, 'week'), [column('period'), ...deliveryColumns]),
    },
    {
      key: 'keywords',
      name: 'Named keywords: delivery and costs',
      description:
        'Named keyword report rows, campaign/ad group and currency. Cost per tap-attributed install is separate from cost per all reported installs. Top 200 rows by spend.',
      query: table(appleAdsKeywordQuery(), [
        column('keyword'),
        column('match_type'),
        ...deliveryColumns.filter((entry) => entry.column !== 'campaign_name'),
        column('ad_group_id'),
        column('keyword_id'),
      ]),
    },
    {
      key: 'unmapped-spend',
      name: 'Spend outside named keyword rows',
      description:
        'Campaign spend minus all named-keyword spend in the same reporting range and currency. Residual source is not inferred; it is not automatically Search Match.',
      query: table(appleAdsUnmappedSpendQuery()),
    },
    {
      key: 'attribution-coverage',
      name: 'Attributed people: coverage and missing evidence',
      description:
        'All currently attributed people with native production iOS activity in the selected range. Missing screens and unidentified people remain in this denominator. Signup counts are observed evidence, not a reliable historical conversion rate.',
      query: table(appleAdsCoverageQuery()),
    },
    {
      key: 'climbing-outcomes',
      name: 'Clean attributed newcomers: climbing outcomes',
      description:
        'Existing first-ever newcomer membership, current Apple association, exact elapsed windows from first screen. Eligible denominators include every mature clean newcomer, independent of signup or prior activation. Signup evidence can precede the first screen. Null rates are pending.',
      query: table(appleAdsOutcomesQuery(), outcomeColumns()),
    },
    {
      key: 'auth-quality',
      name: 'Auth measurement integrity by release',
      description:
        'Relevant auth/board events only, grouped by version and OTA. Target 2.7.0 first, then latest event; up to 500 groups. 2.6.0 remains incomplete; 2.7.0 awaits release evidence.',
      query: table(appleAdsAuthQualityQuery()),
    },
    {
      key: 'auth-counts',
      name: 'Observed login and signup events by provider',
      description:
        'Native unique-person event series by app version, provider and OTA. Top 25 breakdowns plus Others; this limited diagnostic is not a completeness check or ordered funnel.',
      query: appleAdsAuthTrendsQuery,
    },
  ],
  details: [
    {
      key: 'outcomes-keyword',
      name: 'Attributed newcomer outcomes by keyword',
      description:
        'Current keyword association; unknown retained. These consented-person outcomes are separate from keyword spend and do not establish first-touch acquisition.',
      query: table(appleAdsOutcomesQuery(undefined, undefined, 'keyword'), outcomeColumns()),
    },
    {
      key: 'outcomes-country',
      name: 'Attributed newcomer outcomes by Apple region',
      description:
        'Apple attribution country/region; unknown retained. Counts cannot compare country performance without consent and campaign-cost coverage.',
      query: table(appleAdsOutcomesQuery(undefined, undefined, 'country'), outcomeColumns()),
    },
  ],
  baselineIntro: {
    tileId: 13378283,
    body: `### All-source iOS baseline
The charts below keep their original definitions: all-source iOS newcomers in Australia, Spain and the United States. They are not Apple Ads conversion charts.

Entry country is IP geolocation, not Apple targeting. Recent cohorts have less time to climb. For attributed people, coverage and mature outcomes, use the sections above.`,
  },
  baselineInsightIds: [12710428, 12710441, 12710442, 12710444, 12710446, 12710447, 12710450],
};
