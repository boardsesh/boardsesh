import { describe, expect, it } from 'vitest';
import { allFamilies } from '../../workers/families';
import { SCHEDULE_KEY_PATTERN, scheduleKey } from '../batch-schedules';

// batch-schedules.test.ts mocks both pg-boss and the registry, so it cannot see
// pg-boss rejecting a key. This checks every real schedule against pg-boss's
// own key rule: a bad key makes startBatchSchedules register nothing.
describe('real family schedule keys', () => {
  const schedules = allFamilies().flatMap((family) =>
    (family.schedules ?? []).map((schedule) => ({ family: family.name, key: schedule.key })),
  );

  it('covers at least one schedule', () => {
    expect(schedules.length).toBeGreaterThan(0);
  });

  it.each(schedules)('$family / $key is a key pg-boss accepts', ({ family, key }) => {
    expect(scheduleKey(family, key)).toMatch(SCHEDULE_KEY_PATTERN);
  });
});
