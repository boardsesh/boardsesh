import { describe, it, expect } from 'vitest';
import { bucketSessionsByRecency } from '../feed-time-buckets';

// Fixed clock: 2026-06-04T12:00:00Z. The helper buckets off the local calendar
// day, but these timestamps are spaced far enough apart that they land in the
// intended bucket regardless of the test runner's timezone.
const NOW = Date.parse('2026-06-04T12:00:00.000Z');

function session(id: string, lastTickAt: string) {
  return { sessionId: id, lastTickAt };
}

describe('bucketSessionsByRecency', () => {
  it('splits sessions into today / this week / earlier', () => {
    const groups = bucketSessionsByRecency(
      [
        session('today', '2026-06-04T09:00:00.000Z'),
        session('threeDaysAgo', '2026-06-01T09:00:00.000Z'),
        session('lastMonth', '2026-05-01T09:00:00.000Z'),
      ],
      NOW,
    );
    expect(groups.map((group) => group.bucket)).toEqual(['today', 'thisWeek', 'earlier']);
    expect(groups[0].sessions[0].sessionId).toBe('today');
    expect(groups[1].sessions[0].sessionId).toBe('threeDaysAgo');
    expect(groups[2].sessions[0].sessionId).toBe('lastMonth');
  });

  it('drops empty buckets and keeps the most-recent-first order', () => {
    // Both timestamps are well over a week before NOW (2026-06-04), so they
    // collapse into a single "earlier" group.
    const groups = bucketSessionsByRecency(
      [session('older', '2026-05-01T09:00:00.000Z'), session('newer', '2026-05-15T09:00:00.000Z')],
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].bucket).toBe('earlier');
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(['newer', 'older']);
  });

  it('treats a session exactly 7 days old as this week, not earlier', () => {
    const sevenDaysAgo = new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString();
    const groups = bucketSessionsByRecency([session('boundary', sevenDaysAgo)], NOW);
    expect(groups[0].bucket).toBe('thisWeek');
  });

  it('sorts within a bucket newest-first regardless of input order', () => {
    const groups = bucketSessionsByRecency(
      [
        session('b', '2026-06-02T09:00:00.000Z'),
        session('a', '2026-06-03T09:00:00.000Z'),
        session('c', '2026-06-01T09:00:00.000Z'),
      ],
      NOW,
    );
    expect(groups[0].bucket).toBe('thisWeek');
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for no sessions', () => {
    expect(bucketSessionsByRecency([], NOW)).toEqual([]);
  });
});
