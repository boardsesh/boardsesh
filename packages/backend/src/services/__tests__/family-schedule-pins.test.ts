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
