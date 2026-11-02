/** Synthetic rows only. Execute these exact queries through PostHog before recording fixture results. */
import {
  appleAdsAuthQualityQuery,
  appleAdsCoverageQuery,
  appleAdsDeliveryQuery,
  appleAdsFreshnessQuery,
  appleAdsKeywordQuery,
  appleAdsOutcomesQuery,
  appleAdsReportingRange,
  appleAdsUnmappedSpendQuery,
  type AppleAdsQuerySources,
  type AppleAdsQueryWindow,
} from './apple-ads-queries';

type Cell = string | number | boolean | null;
function literal(content: Cell): string {
  if (content === null) return 'NULL';
  if (typeof content === 'boolean') return content ? 'true' : 'false';
  if (typeof content === 'number') return String(content);
  return `'${content.replaceAll("'", "''")}'`;
}
function rows(columns: string[], records: Cell[][]): string {
  return records
    .map((record) => `SELECT ${record.map((content, index) => `${literal(content)} AS ${columns[index]}`).join(', ')}`)
    .join('\nUNION ALL\n');
}

const campaignColumns = [
  'report_day',
  'campaign_id',
  'campaign_name',
  'currency',
  'spend',
  'impressions',
  'taps',
  'installs',
  'new_downloads',
  'redownloads',
  'tap_installs',
  'view_installs',
];
const campaignRows: Cell[][] = [
  ['2026-10-01', 'campaign-a', 'Synthetic campaign', 'AUD', 10, 100, 10, 8, 7, 1, 5, 3],
  ['2026-10-01', 'campaign-a', 'Synthetic campaign', 'AUD', 10, 100, 10, 8, 7, 1, 5, 3],
  ['2026-10-02', 'campaign-a', 'Synthetic campaign', 'AUD', 12, 120, 12, 6, 6, 0, 4, 2],
  ['2026-10-02', 'campaign-a', 'Synthetic campaign', 'USD', 5, 50, 5, 3, 2, 1, 2, 1],
  ['2026-10-03', 'campaign-a', 'Synthetic campaign', null, null, null, null, null, null, null, null, null],
];
const keywordColumns = [
  'report_day',
  'campaign_id',
  'ad_group_id',
  'keyword_id',
  'keyword',
  'match_type',
  'currency',
  'spend',
  'impressions',
  'taps',
  'installs',
  'new_downloads',
  'redownloads',
  'tap_installs',
  'view_installs',
];
const keywordRows: Cell[][] = [
  ['2026-10-01', 'campaign-a', 'group-a', 'keyword-a', 'synthetic a', 'EXACT', 'AUD', 6, 60, 6, 4, 4, 0, 3, 1],
  ['2026-10-01', 'campaign-a', 'group-a', 'keyword-a', 'synthetic a', 'EXACT', 'AUD', 6, 60, 6, 4, 4, 0, 3, 1],
  ['2026-10-02', 'campaign-a', 'group-a', 'keyword-a', 'synthetic a', 'EXACT', 'AUD', 4, 40, 4, 3, 3, 0, 2, 1],
  ['2026-10-02', 'campaign-a', 'group-a', 'keyword-b', 'synthetic b', 'EXACT', 'AUD', 4, 40, 4, 2, 1, 1, 1, 1],
];

type PersonFixture = {
  id: string;
  acquired?: string;
  identified?: boolean;
  conversion?: string;
  claim?: string;
  keyword?: string;
  country?: string;
};
const people: PersonFixture[] = [
  { id: 'late-attribution', acquired: '2026-09-01 12:00:00', identified: true },
  { id: 'no-signup', acquired: '2026-10-20 12:00:00' },
  { id: 'immature', acquired: '2026-10-29 12:00:00' },
  { id: 'exact-seven', acquired: '2026-10-25 00:00:00' },
  { id: 'exact-28', acquired: '2026-10-04 00:00:00' },
  { id: 'spray-active', acquired: '2026-10-10 12:00:00' },
  { id: 'spray-save-only', acquired: '2026-10-12 12:00:00' },
  { id: 'returning-account', identified: true, conversion: 'Redownload' },
  { id: 'no-screen' },
  {
    id: 'unknown-dimensions',
    acquired: '2026-10-18 12:00:00',
    keyword: 'Unknown',
    country: 'Unknown',
    claim: 'Impression',
  },
  { id: 'created-before-screen', acquired: '2026-09-01 00:05:00', identified: true },
];
const peopleSql = rows(
  ['person_id', 'is_identified', 'campaign_id', 'keyword_id', 'country', 'conversion_type', 'claim_type'],
  people.map((person) => [
    person.id,
    person.identified ?? false,
    'campaign-a',
    person.keyword ?? 'keyword-a',
    person.country ?? 'AU',
    person.conversion ?? 'Download',
    person.claim ?? 'Click',
  ]),
);
const newcomerRows = rows(
  ['person_id', 'acquired_text', 'entry_version', 'cutoff_text'],
  people.filter((person) => person.acquired).map((person) => [person.id, person.acquired!, '2.6.0', '2026-11-01']),
);
const newcomersSql = `SELECT person_id, toDateTime(acquired_text) AS acquired_at, entry_version,
  toDate(cutoff_text) AS computed_as_of FROM (${newcomerRows})`;

const activityColumns = [
  'person_id',
  'event_uuid',
  'event',
  'timestamp_text',
  'board_type',
  'board_name',
  'trigger',
  'app_version',
  'provider',
  'ota_update_id',
];
const activityRows: Cell[][] = people
  .filter((person) => person.acquired)
  .map((person) => [
    person.id,
    `${person.id}-screen`,
    '$screen',
    person.acquired!,
    null,
    null,
    null,
    '2.6.0',
    null,
    'fixture-ota',
  ]);
function event(
  personId: string,
  name: string,
  timestamp: string,
  options: { uuid?: string; boardType?: string; boardName?: string; trigger?: string } = {},
) {
  activityRows.push([
    personId,
    options.uuid ?? `${personId}-${activityRows.length}`,
    name,
    timestamp,
    options.boardType ?? null,
    options.boardName ?? null,
    options.trigger ?? null,
    '2.6.0',
    null,
    'fixture-ota',
  ]);
}
event('late-attribution', 'Signup Completed', '2026-09-01 12:01:00', { uuid: 'creation-stable-uuid' });
event('late-attribution', 'Signup Completed', '2026-09-01 12:01:00', { uuid: 'creation-stable-uuid' });
event('late-attribution', 'Install Attributed', '2026-10-15 12:00:00');
event('late-attribution', 'Climb Sent to Board Success', '2026-09-01 12:02:00');
event('late-attribution', 'Climb Sent to Board Success', '2026-09-02 12:00:00');
event('late-attribution', 'Climb Sent to Board Success', '2026-09-08 12:00:00');
event('late-attribution', 'Climb Sent to Board Success', '2026-09-29 12:00:00');
event('no-signup', 'Climb Sent to Board Success', '2026-10-21 12:00:00');
event('immature', 'Climb Sent to Board Success', '2026-10-30 12:00:00');
event('exact-seven', 'Climb Sent to Board Success', '2026-11-01 00:00:00');
event('exact-28', 'Climb Sent to Board Success', '2026-10-05 00:00:00');
event('exact-28', 'Climb Sent to Board Success', '2026-10-31 23:00:00');
event('exact-28', 'Climb Sent to Board Success', '2026-11-01 00:00:00');
event('spray-active', 'Board Created', '2026-10-10 12:01:00', { boardType: 'spray' });
event('spray-active', 'Set Active Climb', '2026-10-10 12:02:00', { boardType: 'spray', trigger: 'climb_saved' });
event('spray-active', 'Set Active Climb', '2026-10-11 12:00:00', { boardType: 'spray', trigger: 'put_on_wall' });
event('spray-save-only', 'Wall Taken', '2026-10-12 12:01:00', { boardName: 'spray' });
event('spray-save-only', 'Set Active Climb', '2026-10-12 12:02:00', { boardType: 'spray', trigger: 'climb_saved' });
event('spray-save-only', 'Set Active Climb', '2026-10-12 12:03:00', { boardType: 'spray', trigger: 'queue_restore' });
event('returning-account', '$screen', '2026-10-20 00:00:00');
event('returning-account', 'Climb Sent to Board Success', '2026-10-20 00:01:00');
// Coverage includes people whose only in-range event is outside the outcome event allowlist.
event('no-screen', 'Auth Option Tapped', '2026-10-21 00:00:00');
event('unknown-dimensions', 'Install Attributed', '2026-10-18 12:01:00');
event('created-before-screen', 'Signup Completed', '2026-08-31 23:59:00');
// An old anonymous distinct id now resolves to the same canonical person; duplicate capture stays one person.
activityRows.push([...activityRows[0]]);
const activitySql = `SELECT person_id, event_uuid, event, toDateTime(timestamp_text) AS timestamp,
  board_type, board_name, trigger, app_version, provider, ota_update_id FROM (${rows(activityColumns, activityRows)})
  WHERE timestamp < toDateTime('2026-11-01 00:00:00')`;

export const APPLE_ADS_FIXTURE_WINDOW: AppleAdsQueryWindow = {
  from: "toDateTime('2026-09-01 00:00:00')",
  to: "toDateTime('2026-11-01 00:00:00')",
  cutoff: "toDateTime('2026-11-01 00:00:00')",
};
export const APPLE_ADS_FIXTURE_SOURCES: AppleAdsQuerySources = {
  campaignRows: rows(campaignColumns, campaignRows),
  keywordRows: rows(keywordColumns, keywordRows),
  people: peopleSql,
  activity: activitySql,
  observedPeople: `SELECT person_id FROM (${activitySql}) WHERE timestamp >= ${APPLE_ADS_FIXTURE_WINDOW.from}
    AND timestamp < ${APPLE_ADS_FIXTURE_WINDOW.to} GROUP BY person_id`,
  registrations: `SELECT person_id, event_uuid, timestamp FROM (${activitySql}) WHERE event = 'Signup Completed'`,
  newcomers: newcomersSql,
  nativeFreshness: "SELECT toDateTime('2026-10-31 23:00:00') AS latest_native_event_utc",
  modelFreshness: "SELECT toDate('2026-11-01') AS model_cutoff",
};
const conflictingSources = {
  ...APPLE_ADS_FIXTURE_SOURCES,
  campaignRows: rows(campaignColumns, [
    ...campaignRows,
    ['2026-10-01', 'campaign-a', 'Synthetic campaign', 'AUD', 11, 100, 10, 8, 7, 1, 5, 3],
  ]),
};
const staleSources = {
  ...APPLE_ADS_FIXTURE_SOURCES,
  newcomers: newcomersSql.replaceAll("'2026-11-01'", "'2026-10-27'"),
};
function reportWindowSources(to: string): AppleAdsQuerySources {
  const window = { ...APPLE_ADS_FIXTURE_WINDOW, from: "toDateTime('2026-10-01 00:00:00')", to };
  return {
    ...APPLE_ADS_FIXTURE_SOURCES,
    campaignRows: `SELECT * FROM (${APPLE_ADS_FIXTURE_SOURCES.campaignRows}) WHERE ${appleAdsReportingRange(window, 'report_day')}`,
  };
}

const authQualityRows: Cell[][] = Array.from({ length: 120 }, (_, index) => [
  `old-screen-${index}`,
  `old-screen-event-${index}`,
  '$screen',
  '2026-10-31 23:59:00',
  null,
  null,
  null,
  '2.5.0',
  null,
  `screen-only-ota-${index}`,
]);
authQualityRows.push(
  [
    'target-user',
    'target-attempt',
    'Login Attempted',
    '2026-10-31 23:50:00',
    null,
    null,
    null,
    '2.7.0',
    'apple',
    'target-270-ota',
  ],
  [
    'target-user',
    'target-success',
    'Login Succeeded',
    '2026-10-31 23:51:00',
    null,
    null,
    null,
    '2.7.0',
    'apple',
    'target-270-ota',
  ],
  [
    'target-user',
    'target-signup',
    'Signup Completed',
    '2026-10-31 23:52:00',
    null,
    null,
    null,
    '2.7.0',
    'apple',
    'target-270-ota',
  ],
  [
    'target-user',
    'target-board',
    'Climb Sent to Board Success',
    '2026-10-31 23:53:00',
    null,
    null,
    null,
    '2.7.0',
    null,
    'target-270-ota',
  ],
  [
    'legacy-user',
    'legacy-attempt',
    'Login Attempted',
    '2026-10-31 23:54:00',
    null,
    null,
    null,
    '2.6.0',
    'google',
    'known-incomplete-260-ota',
  ],
  [
    'legacy-user',
    'legacy-board',
    'Climb Sent to Board Success',
    '2026-10-31 23:55:00',
    null,
    null,
    null,
    '2.6.0',
    null,
    'known-incomplete-260-ota',
  ],
);
const authQualitySources: AppleAdsQuerySources = {
  ...APPLE_ADS_FIXTURE_SOURCES,
  activity: `SELECT person_id, event_uuid, event, toDateTime(timestamp_text) AS timestamp,
    board_type, board_name, trigger, app_version, provider, ota_update_id FROM (${rows(activityColumns, authQualityRows)})`,
};

export const appleAdsFixtures = {
  delivery: appleAdsDeliveryQuery(APPLE_ADS_FIXTURE_SOURCES),
  conflictingDelivery: appleAdsDeliveryQuery(conflictingSources),
  keywords: appleAdsKeywordQuery(APPLE_ADS_FIXTURE_SOURCES),
  unmappedSpend: appleAdsUnmappedSpendQuery(APPLE_ADS_FIXTURE_SOURCES),
  coverage: appleAdsCoverageQuery(APPLE_ADS_FIXTURE_SOURCES, APPLE_ADS_FIXTURE_WINDOW),
  outcomes: appleAdsOutcomesQuery(APPLE_ADS_FIXTURE_SOURCES, APPLE_ADS_FIXTURE_WINDOW),
  staleOutcomes: appleAdsOutcomesQuery(staleSources, APPLE_ADS_FIXTURE_WINDOW),
  inclusiveReportEnd: appleAdsDeliveryQuery(reportWindowSources("toDateTime('2026-10-02 23:59:59')")),
  exclusiveReportEnd: appleAdsDeliveryQuery(reportWindowSources("toDateTime('2026-10-02 00:00:00')")),
  emptyFreshness: appleAdsFreshnessQuery({
    ...APPLE_ADS_FIXTURE_SOURCES,
    campaignRows: `SELECT * FROM (${APPLE_ADS_FIXTURE_SOURCES.campaignRows}) WHERE 1 = 0`,
    nativeFreshness: "SELECT toDateTime('2026-10-31 23:00:00') AS latest_native_event_utc WHERE 1 = 0",
    modelFreshness: "SELECT toDate('2026-11-01') AS model_cutoff WHERE 1 = 0",
  }),
  authQuality: appleAdsAuthQualityQuery(authQualitySources, APPLE_ADS_FIXTURE_WINDOW),
};
