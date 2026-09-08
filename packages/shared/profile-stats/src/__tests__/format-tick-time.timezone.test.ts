// Isolated in its own file (rather than sharing `format-tick-time.test.ts`)
// because it mutates `process.env.TZ` — a process-global — and needs that
// mutation to take effect before dayjs computes any local time, and reverted
// afterward so it can't leak into other test files run in the same worker.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect, afterAll } from 'vitest';
import { formatTickRelativeTime } from '../format-tick-time';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('formatTickRelativeTime on a non-UTC device (America/Los_Angeles)', () => {
  it("matches the UTC-vs-UTC comparison .fromNow() used to make ('3 months ago')", () => {
    // Regression case: `target.from(dayjs(nowMs))` (LOCAL mode "now") renders
    // '2 months ago' here, because dayjs's month-diff reads each side's own
    // calendar fields and a LOCAL "now" disagrees with the UTC-mode target on
    // which month it's in relative to DST/offset. `target.from(dayjs.utc(nowMs))`
    // keeps both sides in UTC mode, matching what plain `.fromNow()` compared
    // against (`dayjs.utc()`) before this `nowMs` parameter existed.
    const climbedAt = '2026-03-31T06:00:00Z';
    const nowMs = Date.parse('2026-06-15T12:00:00Z');

    expect(formatTickRelativeTime(climbedAt, nowMs)).toBe('3 months ago');
  });
});
