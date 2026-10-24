import { communityQueries, type CommunitySources } from './community-queries';

/**
 * Literal rows standing in for the three live sources, so each dashboard query
 * can run in PostHog against known input. `community-fixture-validation.json`
 * records what PostHog returned for the exact query text; the test checks the
 * text is unchanged and the rows say what they should.
 *
 * Shape of the data: October and November 2026 are complete, December is
 * still running. November is the latest complete month, so every ranking
 * reads November and compares it with October.
 */
const summaryRows = [
  // month, complete, climbers_who_lit, climbs_lit, sends_logged, climbers_who_logged, new_accounts, gyms_with_activity
  `'2026-10', true, 1900, 50000, 16000, 1700, 1300, 310`,
  `'2026-11', true, 2104, 1234567, 18400, 1850, 1450, 342`,
  `'2026-12', false, 400, 9000, 2000, 380, 300, 120`,
];

const rankRows = [
  // month, complete, list, rank, is_empty, gym_name, gym_slug, climbers, climbs_lit, climber_name, sends, flashes, send_days
  `'2026-10', true, 'gyms', 1, false, 'Crag B', 'crag-b', 130, 4000, '', 0, 0, 0`,
  `'2026-10', true, 'gyms', 3, false, 'Gym A', 'gym-a', 90, 2500, '', 0, 0, 0`,
  `'2026-10', true, 'climbers', 1, false, '', '', 0, 0, '', 450, 40, 20`,
  `'2026-10', true, 'climbers', 2, false, '', '', 0, 0, 'Sam', 400, 35, 18`,
  `'2026-11', true, 'gyms', 2, false, 'Crag B', 'crag-b', 1200, 3900, '', 0, 0, 0`,
  `'2026-11', true, 'gyms', 1, false, 'Gym A', 'gym-a', 1500, 5000, '', 0, 0, 0`,
  `'2026-11', true, 'gyms', 3, false, 'No Link Gym', '', 40, 900, '', 0, 0, 0`,
  `'2026-11', true, 'gyms', 4, true, '', '', 0, 0, '', 0, 0, 0`,
  `'2026-11', true, 'climbers', 1, false, '', '', 0, 0, 'Sam', 1412, 50, 22`,
  `'2026-11', true, 'climbers', 2, false, '', '', 0, 0, '', 380, 30, 15`,
  `'2026-11', true, 'climbers', 3, false, '', '', 0, 0, 'Alex', 300, 25, 12`,
  `'2026-11', true, 'climbers', 4, true, '', '', 0, 0, '', 0, 0, 0`,
  `'2026-12', false, 'gyms', 1, false, 'Running Month Gym', 'running', 50, 100, '', 0, 0, 0`,
];

const activeUserRows = [`'2026-11-29', 3000`, `'2026-11-30', 3105`, `'2026-10-31', 2990`];

function literalRows(columns: string[], rows: string[]): string {
  const [first, ...rest] = rows;
  const header = first
    .split(', ')
    .map((value, index) => `${value} AS ${columns[index]}`)
    .join(', ');
  return [`SELECT ${header}`, ...rest.map((row) => `UNION ALL SELECT ${row}`)].join('\n    ');
}

/**
 * A literal row splits on ', ', so no fixture value may contain one. The
 * header row also names the columns, so it must spell every one out.
 */
export const communityFixtureSources: CommunitySources = {
  summary: literalRows(
    [
      'month',
      'complete',
      'climbers_who_lit',
      'climbs_lit',
      'sends_logged',
      'climbers_who_logged',
      'new_accounts',
      'gyms_with_activity',
    ],
    summaryRows,
  ),
  ranks: literalRows(
    [
      'month',
      'complete',
      'list',
      'rank',
      'is_empty',
      'gym_name',
      'gym_slug',
      'climbers',
      'climbs_lit',
      'climber_name',
      'sends',
      'flashes',
      'send_days',
    ],
    rankRows,
  ),
  activeUsers: literalRows(['day', 'monthly_active_users'], activeUserRows),
};

export const communityFixtures = Object.fromEntries(
  Object.entries(communityQueries).map(([name, build]) => [name, build(communityFixtureSources)]),
) as Record<keyof typeof communityQueries, string>;
