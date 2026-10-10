/** Synthetic inputs executed through the same saved HogQL, without production identities. */
import {
  activationQuery,
  bucketsQuery,
  cohortRetentionQuery,
  newcomersQuery,
  sourceQualityQuery,
  type QuerySources,
} from './growth-queries';

function textLiteral(content: string): string {
  return `'${content.replaceAll("'", "''")}'`;
}
function timestampLiteral(timestamp: string): string {
  return `toDateTime(${textLiteral(timestamp)})`;
}
function timestamps(timestampsToEncode: string[]): string {
  return `[${timestampsToEncode.map(timestampLiteral).join(', ')}]`;
}

const fixtureSources: QuerySources = {
  days: 'fixture_days',
  newcomers: 'fixture_newcomers',
  cutoff: "toDate('2026-10-10')",
};

const previousRows = [1, 2, 3, 4, 7, 8].flatMap((days, index) =>
  Array.from(
    { length: days },
    (_, dayIndex) => `SELECT 'person-${index}' AS person_id,
    toDate('2026-08-14') + ${dayIndex} AS activity_day, 3 AS board_sends, toDate('2026-10-10') AS computed_as_of`,
  ),
);
const returnRows = [0, 2, 4, 5].map(
  (index) => `SELECT 'person-${index}', toDate('2026-09-11'), 1, toDate('2026-10-10')`,
);
const boundaryRows = [
  "SELECT 'outside-before', toDate('2026-08-13'), 1, toDate('2026-10-10')",
  "SELECT 'person-1', toDate('2026-10-09'), 1, toDate('2026-10-10')",
  "SELECT 'zero-board-user', toDate('2026-08-14'), 0, toDate('2026-10-10')",
];
const fixtureDays = `fixture_days AS (${[...previousRows, ...returnRows, ...boundaryRows].join('\nUNION ALL\n')})`;

interface Entrant {
  id: string;
  acquired?: string;
  accountDate?: string;
  registrations?: string[];
  sends: string[];
  installSeconds?: number;
  landing?: string;
  landingUrl?: string;
  platform?: string;
}
const entrants: Entrant[] = [
  {
    id: 'ordered-four',
    accountDate: '2026-01-01 00:00:00',
    registrations: ['2026-09-11 12:10:00'],
    sends: [
      '2026-09-11 12:05:00',
      '2026-09-11 12:11:00',
      '2026-09-11 12:12:00',
      '2026-09-12 13:00:00',
      '2026-09-14 13:00:00',
      '2026-10-08 13:00:00',
      '2026-10-09 13:00:00',
    ],
  },
  { id: 'no-registration', accountDate: '2026-01-01 00:00:00', sends: ['2026-09-11 12:11:00', '2026-09-12 13:00:00'] },
  { id: 'invalid-account-date', accountDate: '2026-99-99', sends: [] },
  { id: 'property-registration', accountDate: '2026-09-11 12:10:00', sends: ['2026-09-11 12:11:00'] },
  {
    id: 'earliest-web',
    acquired: '2026-09-11 12:01:00',
    landing: '2026-09-11 11:00:00',
    landingUrl: 'https://boardsesh.com/?utm_source=reddit&utm_campaign=first-community',
    installSeconds: Date.parse('2026-09-11T11:30:00Z') / 1000,
    sends: ['2026-09-11 12:00:00', '2026-09-11 12:02:00'],
  },
  { id: 'old-install', installSeconds: Date.parse('2026-09-06T11:30:00Z') / 1000, sends: [] },
  {
    id: 'pre-registration-day',
    registrations: ['2026-09-12 10:00:00'],
    sends: ['2026-09-11 13:00:00', '2026-09-12 11:00:00'],
  },
  { id: 'known-play', installSeconds: Date.parse('2026-09-11T11:30:00Z') / 1000, sends: [] },
  { id: 'ios-is-unknown', platform: 'iOS', installSeconds: Date.parse('2026-09-11T11:30:00Z') / 1000, sends: [] },
];

const entrantRows = entrants.map(
  (entrant) => `SELECT
  ${textLiteral(entrant.id)} AS person_id,
  ${timestampLiteral(entrant.acquired ?? '2026-09-11 12:00:00')} AS acquired_at,
  toDate('2026-09-11') AS acquired_day,
  toDateTime('2026-09-11 12:00:00') AS first_native_at,
  ${textLiteral(entrant.platform ?? (entrant.installSeconds ? 'Android' : 'iOS'))} AS platform,
  '2.5.0' AS entry_version, '1' AS entry_build, 'AU' AS country,
  ${entrant.landing ? timestampLiteral(entrant.landing) : 'NULL'} AS first_landing_at,
  ${textLiteral(entrant.landingUrl ?? '')} AS first_landing_url,
  '' AS first_referrer, ${textLiteral(entrant.accountDate ?? '')} AS account_created_text,
  'google-play' AS install_source, 'organic' AS install_medium, 'play-campaign' AS install_campaign,
  ${entrant.installSeconds ?? 0} AS install_begin_seconds,
  toDate('2026-10-10') AS computed_as_of`,
);
const factRows = entrants.map(
  (entrant) => `SELECT
  ${textLiteral(entrant.id)} AS person_id,
  ${timestamps(entrant.registrations ?? [])} AS registration_timestamps,
  ${timestamps(entrant.sends)} AS board_timestamps,
  ${timestamps([entrant.acquired ?? '2026-09-11 12:00:00'])} AS app_timestamps,
  [] AS search_timestamps, [] AS connection_timestamps`,
);

const milestoneQuery = `WITH entrants AS (${entrantRows.join('\nUNION ALL\n')}),
native_facts AS (${factRows.join('\nUNION ALL\n')}),
${newcomersQuery.slice(newcomersQuery.indexOf('  observed AS ('))}
ORDER BY person_id`;

const maturityPeople = [
  { id: 'full-56', day: '2026-08-15', boardDays: 4, registered: true, returned: true },
  { id: 'just-28', day: '2026-09-12', boardDays: 2, registered: true, returned: false },
  { id: 'immature-27', day: '2026-09-13', boardDays: 4, registered: true, returned: true },
  { id: 'no-registration', day: '2026-09-11', boardDays: 0, registered: false, returned: false },
].map(
  (person) => `SELECT ${textLiteral(person.id)} AS person_id, toDate(${textLiteral(person.day)}) AS acquired_day,
  ${person.registered ? 1 : 0} AS registered_first28, ${person.boardDays} AS ordered_board_days_first28,
  ${person.returned ? 1 : 0} AS board_next28, toDate('2026-10-10') AS computed_as_of,
  [toDate(${textLiteral(person.day)})] AS app_days, [toDate(${textLiteral(person.day)})] AS board_days,
  'Direct / unknown' AS acquisition_source, ${person.boardDays} AS board_days_first28,
  ${person.returned ? 1 : 0} AS board_day28, ${person.returned ? 1 : 0} AS app_day28,
  ${person.returned ? 1 : 0} AS app_next28, 0 AS first28_searches, 0 AS first28_connections`,
);
const fixtureNewcomers = `fixture_newcomers AS (${maturityPeople.join('\nUNION ALL\n')})`;

export const growthFixtures = {
  buckets: `WITH ${fixtureDays} SELECT * FROM (${bucketsQuery(fixtureSources)})`,
  staleBuckets: `WITH ${fixtureDays.replaceAll("toDate('2026-10-10') AS computed_as_of", "toDate('2026-11-05') AS computed_as_of").replaceAll(", toDate('2026-10-10')", ", toDate('2026-11-05')")} SELECT * FROM (${bucketsQuery({ ...fixtureSources, cutoff: "toDate('2026-11-06')" })})`,
  milestones: milestoneQuery,
  activation: `WITH ${fixtureNewcomers} SELECT * FROM (${activationQuery(fixtureSources)})`,
  cohortMaturity: `WITH ${fixtureNewcomers} SELECT * FROM (${cohortRetentionQuery('board', fixtureSources)})`,
  sourceMaturity: `WITH ${fixtureNewcomers} SELECT * FROM (${sourceQualityQuery(fixtureSources)})`,
};
