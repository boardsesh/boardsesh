import {
  PAID_SOCIAL_PROJECT_ID,
  PAID_SOCIAL_SOURCES,
  paidSocialAdsQuery,
  paidSocialAndroidInstallsQuery,
  paidSocialAndroidOutcomesQuery,
  paidSocialLandingQuery,
  paidSocialStoreClicksQuery,
} from './paid-social-queries';

type Column = {
  column: string;
  settings: { formatting?: { style: 'number'; decimalPlaces: number; suffix?: string } };
};

function column(name: string): Column {
  return {
    column: name,
    settings: name.endsWith('_percent') ? { formatting: { style: 'number', decimalPlaces: 2, suffix: '%' } } : {},
  };
}

function table(query: string, columns: string[]) {
  return {
    kind: 'DataVisualizationNode' as const,
    source: { kind: 'HogQLQuery' as const, query, filters: { dateRange: { date_from: '-28dStart' } } },
    display: 'ActionsTable' as const,
    tableSettings: { columns: columns.map(column) },
  };
}

const iosBody = `### iOS installs from Reddit and Instagram
PostHog cannot see them. An App Store link passes no referrer to the app, so an iOS install from an ad can't be joined to a person here.

Apple counts them in aggregate: **App Store Connect → App Analytics → Acquisition → Campaigns**. A tagged visitor's store link carries the campaign token \`ct=<utm_source>-<utm_campaign>\`, so look for \`reddit-<code>\` and \`instagram-<code>\` (a bare \`fbclid\` visit reads \`meta\`). Tokens are cut to 30 characters.

- A campaign shows only after **5 first-time downloads**.
- Nothing is attributed until \`NEXT_PUBLIC_APP_STORE_PROVIDER_ID\` is set on the web build, which adds the provider token \`pt\` to every App Store link.
- Compare App Store downloads with the iOS click column above; no per-person sign-up or activation exists for iOS ad traffic.`;

const introBody = `### Paid social: Reddit and Instagram ads to www
Ads land on www.boardsesh.com tagged \`utm_source=reddit|instagram&utm_medium=paid-social&utm_campaign=<code>&utm_content=<ad>\`. Sources counted: ${PAID_SOCIAL_SOURCES.join(', ')} (\`meta\` is a visit with a bare \`fbclid\` and no utm tags, which includes unpaid Instagram links: split on medium).

- **www tiles count sessions** whose first pageview URL carried the tags. www visitors are anonymous, so there are no person properties to break down by. Crawlers are removed with the www crawler rule; arm 2 (US Windows Chrome, at most two pages, no store click) is shown separately because it can also remove real desktop visitors.
- **Store clicks are taps, not installs.** Clicks from the browser app at /app carry no landing tags and are not here.
- **Android installs** come from the Play referrer (\`install_source\`, \`install_medium\`, \`install_campaign\`) and are dated by \`install_begin_timestamp\`. The link id is our button (\`placement\`), never the ad: the ad lives in \`utm_content\` on www only.
- Internal cohort 295337 is excluded everywhere. Days are UTC. Zero rows means no tagged traffic yet.

Definitions: scripts/posthog/paid-social-queries.ts and docs/growth-metrics.md, "Paid social (Reddit, Instagram)".`;

export const paidSocialDashboard = {
  projectId: PAID_SOCIAL_PROJECT_ID,
  name: 'Paid social: Reddit and Instagram',
  description:
    'Reddit and Instagram ad traffic on www.boardsesh.com: landing sessions, store clicks per ad, Android installs, sign-ups and 7-day board activation. iOS installs live in App Store Connect.',
  filters: { date_from: '-28dStart' },
  intro: { body: introBody },
  insights: [
    {
      key: 'landing-sessions',
      name: 'Paid social landing sessions by day',
      description:
        'www sessions whose first pageview URL carried a reddit, instagram or meta tag, per UTC day, source, medium and campaign. Crawlers removed; arm 2 removals shown so the count can be quoted as a range.',
      query: table(paidSocialLandingQuery(), [
        'day',
        'source',
        'medium',
        'campaign',
        'landing_sessions',
        'landing_visitors',
        'arm2_sessions_removed',
        'crawler_sessions_removed',
      ]),
    },
    {
      key: 'store-clicks',
      name: 'Paid social store clicks and click-through by day',
      description:
        'App Install Click inside those landing sessions. Click-through is sessions with a click over landing sessions; the iOS and Android columns split the same sessions by store and can overlap.',
      query: table(paidSocialStoreClicksQuery(), [
        'day',
        'source',
        'medium',
        'campaign',
        'landing_sessions',
        'clicking_sessions',
        'click_through_percent',
        'store_clicks',
        'ios_clicks',
        'ios_clicking_sessions',
        'ios_click_through_percent',
        'android_clicks',
        'android_clicking_sessions',
        'android_click_through_percent',
      ]),
    },
    {
      key: 'ads',
      name: 'Paid social by ad (utm_content)',
      description:
        'One row per ad over the selected range: landing sessions, sessions with a store click, click-through and total store clicks. Crawlers removed.',
      query: table(paidSocialAdsQuery(), [
        'source',
        'medium',
        'campaign',
        'ad',
        'landing_sessions',
        'clicking_sessions',
        'click_through_percent',
        'store_clicks',
        'first_day',
        'last_day',
      ]),
    },
    {
      key: 'android-installs',
      name: 'Android installs from paid social by install day',
      description:
        'People whose Play referrer names reddit, instagram or meta, by the day Play says the install began. People with no install time sit in one all-time row and are not new installs.',
      query: table(paidSocialAndroidInstallsQuery(), [
        'install_day',
        'source',
        'medium',
        'campaign',
        'link_id',
        'people',
      ]),
    },
    {
      key: 'android-outcomes',
      name: 'Android paid social installs: sign-ups and 7-day board activation',
      description:
        'Installs that began in the range. Sign-up is Signup Completed from an hour before the install; the 7-day rate counts installs at least 7 days old. Activation uses the Apple Ads definition: clean first-ever Android newcomers who lit a climb within 7 days of their first screen; null until a cohort is 7 days old.',
      query: table(paidSocialAndroidOutcomesQuery(), [
        'source',
        'medium',
        'campaign',
        'new_installs',
        'signup_people_so_far',
        'signup_eligible_7d',
        'signup_7d',
        'signup_7d_percent',
        'clean_newcomers',
        'eligible_7d',
        'board_active_7d',
        'board_activation_7d_percent',
      ]),
    },
  ],
  ios: { body: iosBody },
};
