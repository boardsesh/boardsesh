import { describe, expect, it } from 'vitest';
import { allFamilies } from '../../workers/families';

/**
 * Every family's schedule, pinned. A cron is a production cadence: changing
 * one should be a deliberate edit here too, reviewed next to the docs table in
 * docs/background-workers.md. Families without schedules (the probe, the
 * first-link syncs, enqueued by the backend) have none to pin.
 */
const EXPECTED_SCHEDULES: Record<string, Array<{ key: string; cron: string; tz: string; roles: string[] }>> = {
  'worker-probe': [],
  'refresh-recommendations': [{ key: 'nightly', cron: '0 6 * * *', tz: 'UTC', roles: ['batch'] }],
  'refresh-hold-features': [{ key: 'nightly', cron: '15 6 * * *', tz: 'UTC', roles: ['batch'] }],
  'refresh-climb-grades': [{ key: 'nightly', cron: '30 6 * * *', tz: 'UTC', roles: ['batch'] }],
  'refresh-climb-neighbors': [{ key: 'nightly', cron: '45 6 * * *', tz: 'UTC', roles: ['batch'] }],
  'export-board-snapshots': [
    { key: 'nightly', cron: '15 7 * * *', tz: 'UTC', roles: ['batch'] },
    { key: 'live-scan', cron: '7,22,37,52 * * * *', tz: 'UTC', roles: ['batch'] },
  ],
  'refresh-moonboard-angle-estimates': [{ key: 'weekly', cron: '0 8 * * 1', tz: 'UTC', roles: ['batch'] }],
  'refresh-moonboard-wide-angle-estimates': [{ key: 'weekly', cron: '30 8 * * 1', tz: 'UTC', roles: ['batch'] }],
  'aurora-user-sync': [],
  'kilter-user-sync': [],
  'provider-routine-cycle': [{ key: 'every-5-min', cron: '*/5 * * * *', tz: 'UTC', roles: ['routine-provider'] }],
  'aurora-shared-sync': [{ key: 'hourly', cron: '7 * * * *', tz: 'UTC', roles: ['routine-provider'] }],
  'kilter-catalog-sync': [{ key: 'hourly', cron: '23 * * * *', tz: 'UTC', roles: ['routine-provider'] }],
  'moonboard-locations-sync': [{ key: 'daily', cron: '41 3 * * *', tz: 'UTC', roles: ['routine-provider'] }],
  'climb-stats-self-heal': [{ key: 'hourly', cron: '13 * * * *', tz: 'UTC', roles: ['maintenance-delivery'] }],
};

describe('family schedules', () => {
  it('match the pinned cadence for every registered family', () => {
    const actual = Object.fromEntries(
      allFamilies().map((family) => [
        family.name,
        (family.schedules ?? []).map((schedule) => ({
          key: schedule.key,
          cron: schedule.cron,
          tz: schedule.tz ?? 'UTC',
          roles: schedule.role ? [schedule.role] : [...family.roles],
        })),
      ]),
    );
    expect(actual).toEqual(EXPECTED_SCHEDULES);
  });
});
