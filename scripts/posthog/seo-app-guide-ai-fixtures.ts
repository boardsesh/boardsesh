import { seoAppGuideAiReferralsQuery } from './seo-app-guide-queries';

/** Executed against PostHog, so attribution tests exercise HogQL rather than a JS reimplementation. */
type FixturePageview = {
  person: string;
  session: string;
  time?: string;
  date?: string;
  path?: string;
  referrer?: string;
  ua?: string;
  medium?: string;
  bot?: boolean;
};

const pageviews: FixturePageview[] = [
  { person: 'reader', session: 'repeat-pageviews' },
  { person: 'reader', session: 'repeat-pageviews', time: '10:01:00', referrer: 'www.boardsesh.com' },
  // Two independent AI landings by one person are two sessions.
  { person: 'reader', session: 'returning-session', time: '11:00:00' },
  { person: 'spray', session: 'spray-guide', path: '/compare/spray-wall-apps', referrer: 'perplexity.ai' },
  { person: 'alias', session: 'retired-alias', path: '/apps/tension?source=ai', referrer: 'claude.ai' },
  { person: 'hub', session: 'hub-trailing-slash', path: '/apps/', referrer: 'claude.ai', medium: 'referral' },
  { person: 'spoof', session: 'spoofed-domain', referrer: 'chatgpt.com.example.org' },
  { person: 'subdomain', session: 'unapproved-subdomain', referrer: 'help.chatgpt.com' },
  { person: 'direct', session: 'missing-referrer', referrer: '' },
  { person: 'missing', session: '' },
  { person: 'paid-id', session: 'paid-click-id', path: '/apps/kilter?gclid=paid' },
  { person: 'paid-property', session: 'paid-medium-property', medium: 'cpc' },
  { person: 'paid-url', session: 'paid-medium-url', path: '/apps/kilter?utm_medium=paid_social' },
  // Later guide pageviews cannot replace a session's actual landing or referrer.
  { person: 'existing', session: 'existing-site-landing', path: '/boards' },
  { person: 'existing', session: 'existing-site-landing', time: '10:01:00' },
  { person: 'internal', session: 'internal-navigation', referrer: 'www.boardsesh.com' },
  { person: 'internal', session: 'internal-navigation', time: '10:01:00' },
  // Exact timestamp ties have no chronological order. Stable URL-first tie
  // breaking chooses /apps/aurora with its internal referrer, never /apps/kilter
  // with chatgpt.com or a synthetic combination of the two rows.
  { person: 'timestamp-tie', session: 'timestamp-tie', path: '/apps/kilter' },
  { person: 'timestamp-tie', session: 'timestamp-tie', path: '/apps/aurora', referrer: 'www.boardsesh.com' },
  // A session that began in the entry lookback is not a new landing in the window.
  { person: 'lookback', session: 'prior-day-entry', date: '2026-11-19', time: '23:59:00' },
  { person: 'lookback', session: 'prior-day-entry', time: '00:01:00' },
  { person: 'at-end', session: 'exclusive-end', date: '2026-11-21', time: '00:00:00' },
  { person: 'crawler', session: 'crawler', ua: 'Lightpanda/1.0' },
  { person: 'known', session: 'known-bot', bot: true },
  { person: 'emulator', session: 'emulator', ua: 'Android SDK built' },
  // Keep the existing denominator rule: flag these sessions without removing them.
  { person: 'windows', session: 'possible-automation', ua: 'Windows NT Chrome/150' },
];

const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
const source = pageviews
  .map(
    (pageview) => `SELECT ${literal(pageview.person)} AS person_id, ${literal(pageview.session)} AS session_id,
      '$pageview' AS event, toDateTime('${pageview.date ?? '2026-11-20'} ${pageview.time ?? '10:00:00'}') AS timestamp,
      ${literal(`https://www.boardsesh.com${pageview.path ?? '/apps/kilter'}`)} AS url,
      ${literal(pageview.ua ?? 'iPhone Safari')} AS ua,
      ${literal(pageview.referrer ?? 'chatgpt.com')} AS referring_domain,
      'US' AS country, ${literal(pageview.medium ?? '')} AS medium, ${pageview.bot ? 'true' : 'false'} AS known_bot`,
  )
  .join('\nUNION ALL\n');

export const seoAppGuideAiFixtureQuery = seoAppGuideAiReferralsQuery(
  { from: "toDateTime('2026-11-20')", to: "toDateTime('2026-11-21')" },
  source,
);

/** Columns: referral host, canonical guide, landing sessions, excluded bots, possible automation. */
export const seoAppGuideAiFixtureExpected = [
  ['chatgpt.com', '/apps/kilter', 3, 3, 1],
  ['claude.ai', '/apps', 1, 0, 0],
  ['claude.ai', '/apps/aurora', 1, 0, 0],
  ['perplexity.ai', '/compare/spray-wall-apps', 1, 0, 0],
];
