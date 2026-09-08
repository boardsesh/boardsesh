import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatTickRelativeTime } from '../format-tick-time';

// `formatTickRelativeTime(climbedAt, nowMs)` exists so mobile's screenshot-mode
// frozen clock can pin "now" and still render exactly what `.fromNow()` (no
// `nowMs` arg) would have rendered against the real wall clock at that same
// instant. These tests pin `Date.now()` via fake timers and assert the
// explicit-`now` call is byte-identical to the implicit one, across offsets
// from minutes to years — the two call paths must never diverge.
//
// The specific non-UTC-timezone regression case (see PR description) lives in
// the sibling `format-tick-time.timezone.test.ts` file instead of here, since
// it needs `process.env.TZ` set before dayjs ever computes a local time —
// isolating it to its own file keeps that mutation from leaking into (or
// being affected by) every other test in this suite.

afterEach(() => {
  vi.useRealTimers();
});

const OFFSETS_MINUTES_TO_YEARS = [
  { label: '5 minutes', ms: 5 * 60 * 1000 },
  { label: '2 hours', ms: 2 * 60 * 60 * 1000 },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '10 days', ms: 10 * 24 * 60 * 60 * 1000 },
  { label: '45 days', ms: 45 * 24 * 60 * 60 * 1000 },
  { label: '6 months', ms: 182 * 24 * 60 * 60 * 1000 },
  { label: '2 years', ms: 2 * 365 * 24 * 60 * 60 * 1000 },
];

describe('formatTickRelativeTime with an explicit now', () => {
  for (const { label, ms } of OFFSETS_MINUTES_TO_YEARS) {
    it(`matches the implicit-now (.fromNow()) result for a ${label}-old climb`, () => {
      const now = Date.parse('2026-06-15T12:00:00.000Z');
      vi.useFakeTimers({ now });
      const climbedAt = new Date(now - ms).toISOString();

      const implicit = formatTickRelativeTime(climbedAt);
      const explicit = formatTickRelativeTime(climbedAt, Date.now());

      expect(explicit).toBe(implicit);
    });
  }
});
