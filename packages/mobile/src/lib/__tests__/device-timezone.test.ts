import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDeviceTimezone } from '../device-timezone';

afterEach(() => vi.restoreAllMocks());

describe('getDeviceTimezone', () => {
  it.each([
    ['GMT', 'UTC'],
    ['UTC', 'UTC'],
    ['Europe/London', 'Europe/London'],
    ['America/New_York', 'America/New_York'],
    ['', undefined],
  ])('resolves %s without changing regional daylight-saving rules', (timeZone, expected) => {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...resolved, timeZone });
    expect(getDeviceTimezone()).toBe(expected);
  });

  it('leaves the backend default in effect when Intl cannot resolve the zone', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => {
      throw new Error('Timezone unavailable');
    });
    expect(getDeviceTimezone()).toBeUndefined();
  });
});
