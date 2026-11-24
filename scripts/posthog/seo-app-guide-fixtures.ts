import { seoAppGuideSessionsQuery } from './seo-app-guide-queries';

const window = { from: "toDateTime('2026-11-20')", to: "toDateTime('2026-11-21')" };
type FixtureEvent = {
  person: string;
  session: string;
  event: string;
  time: string;
  path?: string;
  referrer?: string;
  ua?: string;
  medium?: string;
  bot?: boolean;
};
const fixtures: FixtureEvent[] = [
  { person: 'climber', session: 'repeat-clicks', event: '$pageview', time: '10:00:00' },
  { person: 'climber', session: 'repeat-clicks', event: '$pageview', time: '10:01:00' },
  { person: 'climber', session: 'repeat-clicks', event: 'App Install Click', time: '10:02:00' },
  { person: 'climber', session: 'repeat-clicks', event: 'App Install Click', time: '10:03:00' },
  { person: 'climber', session: 'repeat-clicks', event: 'Web App Opened', time: '10:04:00' },
  { person: 'reader', session: 'no-action', event: '$pageview', time: '11:00:00' },
  { person: 'existing', session: 'existing-site', event: '$pageview', time: '11:00:00', path: '/boards' },
  { person: 'existing', session: 'existing-site', event: 'App Install Click', time: '11:01:00', path: '/boards' },
  { person: 'before', session: 'action-before-landing', event: 'App Install Click', time: '09:00:00' },
  { person: 'before', session: 'action-before-landing', event: '$pageview', time: '10:00:00' },
  { person: 'direct', session: 'direct-visit', event: '$pageview', time: '10:00:00', referrer: '' },
  { person: 'paid', session: 'paid-visit', event: '$pageview', time: '10:00:00', path: '/apps/kilter?gclid=paid' },
  { person: 'medium', session: 'paid-medium', event: '$pageview', time: '10:00:00', medium: 'cpc' },
  {
    person: 'spoof',
    session: 'spoof-referrer',
    event: '$pageview',
    time: '10:00:00',
    referrer: 'google.com.example.org',
  },
  { person: 'crawler', session: 'crawler-visit', event: '$pageview', time: '10:00:00', ua: 'Lightpanda/1.0' },
  { person: 'knownbot', session: 'knownbot-visit', event: '$pageview', time: '10:00:00', bot: true },
  { person: 'absent', session: '', event: '$pageview', time: '10:00:00' },
  { person: 'cross', session: 'other-session-click', event: 'App Install Click', time: '10:00:00' },
  { person: 'cross', session: 'landing-without-click', event: '$pageview', time: '10:01:00' },
  { person: 'gmail', session: 'google-product', event: '$pageview', time: '10:00:00', referrer: 'mail.google.com' },
  {
    person: 'gmail',
    session: 'google-product',
    event: 'App Install Click',
    time: '10:01:00',
    referrer: 'mail.google.com',
  },
  {
    person: 'win-reader',
    session: 'windows-reader',
    event: '$pageview',
    time: '10:00:00',
    ua: 'Windows NT Chrome/150',
  },
  { person: 'win-store', session: 'windows-store', event: '$pageview', time: '10:00:00', ua: 'Windows NT Chrome/150' },
  {
    person: 'win-store',
    session: 'windows-store',
    event: 'App Install Click',
    time: '10:01:00',
    ua: 'Windows NT Chrome/150',
  },
  { person: 'win-web', session: 'windows-web', event: '$pageview', time: '10:00:00', ua: 'Windows NT Chrome/150' },
  { person: 'win-web', session: 'windows-web', event: 'Web App Opened', time: '10:01:00', ua: 'Windows NT Chrome/150' },
  // The merged Aurora page, landed on directly and through a retired brand URL.
  { person: 'merged', session: 'merged-page', event: '$pageview', time: '10:00:00', path: '/apps/aurora' },
  { person: 'retired', session: 'retired-alias', event: '$pageview', time: '10:00:00', path: '/apps/tension' },
  { person: 'retired', session: 'retired-alias', event: 'App Install Click', time: '10:01:00', path: '/apps/tension' },
];

const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
const fixtureSource = fixtures
  .map(
    (fixture) => `SELECT ${literal(fixture.person)} AS person_id, ${literal(fixture.session)} AS session_id,
      ${literal(fixture.event)} AS event, toDateTime('2026-11-20 ${fixture.time}') AS timestamp,
      ${literal(`https://www.boardsesh.com${fixture.path ?? '/apps/kilter'}`)} AS url,
      ${literal(fixture.ua ?? 'iPhone Safari')} AS ua,
      ${literal(fixture.referrer ?? 'www.google.com')} AS referring_domain,
      'US' AS country, ${literal(fixture.medium ?? '')} AS medium, ${fixture.bot ? 'true' : 'false'} AS known_bot`,
  )
  .join('\nUNION ALL\n');

export const seoAppGuideFixtureQuery = seoAppGuideSessionsQuery(window, fixtureSource);
export const seoAppGuideFixtureExpected = [
  ['/apps/aurora', 'US', 2, 1, 0, 1, 0, 0],
  ['/apps/kilter', 'US', 7, 2, 2, 3, 2, 3],
  ['existing site', 'US', 1, 1, 0, 1, 0, 0],
];
