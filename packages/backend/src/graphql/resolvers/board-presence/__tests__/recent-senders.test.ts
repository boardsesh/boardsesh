import { describe, expect, it } from 'vitest';
import {
  RECENT_CLIMB_SENDERS_FETCH_LIMIT,
  RECENT_CLIMB_SENDERS_LIMIT,
  RECENT_CLIMB_SENDERS_OVERFETCH,
  toRecentSenders,
  type RecentSenderRow,
} from '../recent-senders';

function row(userId: string, lastSentAt: RecentSenderRow['lastSentAt']): RecentSenderRow {
  return {
    userId,
    senderName: `${userId} account`,
    senderImage: `https://cdn.test/${userId}-account.png`,
    profileDisplayName: null,
    profileAvatarUrl: null,
    lastSentAt,
  };
}

/** Oldest row of a window: every other row is this many whole days later. */
const WINDOW_EPOCH_MS = Date.UTC(2026, 6, 1, 10, 0, 0);
const ONE_DAY_MS = 86_400_000;

/**
 * `daysAfterEpoch` days past {@link WINDOW_EPOCH_MS}, in the offset-less shape
 * the driver hands back for a `timestamp` column (`YYYY-MM-DD HH:mm:ss`) — the
 * input `parsePostgresUtcTimestamp` exists to normalize.
 *
 * Date arithmetic rather than pasting the offset into a `2026-07-DD` template:
 * the template silently leaves the month at a count above 31, and while the
 * assertions below pin exact user ids and would fail rather than pass on the
 * resulting unparseable rows, they would fail for a reason that has nothing to
 * do with what they test.
 */
function postgresTimestamp(daysAfterEpoch: number): string {
  return new Date(WINDOW_EPOCH_MS + daysAfterEpoch * ONE_DAY_MS)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
}

/**
 * A window of `count` rows as Postgres hands them back: newest-first, all
 * readable. The dates descend with the index to match the resolver's
 * `ORDER BY max(climbed_at) DESC` — `toRecentSenders` trusts that order and
 * only slices, so an ascending fixture would still pass while describing
 * output the query never produces.
 */
function readableWindow(count: number): RecentSenderRow[] {
  return Array.from({ length: count }, (_, index) => row(`user-${index}`, postgresTimestamp(count - 1 - index)));
}

describe('toRecentSenders', () => {
  it('normalizes an unzoned Postgres timestamp to UTC and caps at the byline limit', () => {
    const senders = toRecentSenders(readableWindow(RECENT_CLIMB_SENDERS_FETCH_LIMIT));

    expect(senders).toHaveLength(RECENT_CLIMB_SENDERS_LIMIT);
    expect(senders.map((sender) => sender.userId)).toEqual(['user-0', 'user-1', 'user-2', 'user-3', 'user-4']);
    // Newest row of an 8-row window, so the last daily step: epoch + 7 days.
    expect(senders[0].lastSentAt).toBe('2026-07-08T10:00:00.000Z');
  });

  it('prefers profile identity over the auth account', () => {
    const [sender] = toRecentSenders([
      {
        ...row('user-0', '2026-07-01 10:00:00'),
        profileDisplayName: 'Profile Name',
        profileAvatarUrl: 'https://cdn.test/profile.png',
      },
    ]);

    expect(sender).toMatchObject({
      displayName: 'Profile Name',
      avatarUrl: 'https://cdn.test/profile.png',
    });
  });

  it('falls back to null identity when neither profile nor account carries one', () => {
    const [sender] = toRecentSenders([
      { ...row('user-0', '2026-07-01 10:00:00'), senderName: null, senderImage: null },
    ]);

    expect(sender).toMatchObject({ displayName: null, avatarUrl: null });
  });

  it('still fills the byline when the over-fetch cushion is exactly spent', () => {
    // The cushion exists for this: unreadable rows sit inside the window
    // Postgres already returned, and dropping them must not shorten the byline
    // while readable senders are still in hand.
    const rows = readableWindow(RECENT_CLIMB_SENDERS_FETCH_LIMIT);
    for (let index = 0; index < RECENT_CLIMB_SENDERS_OVERFETCH; index += 1) {
      rows[index] = row(`corrupt-${index}`, 'not a timestamp');
    }

    const senders = toRecentSenders(rows);

    expect(senders).toHaveLength(RECENT_CLIMB_SENDERS_LIMIT);
    expect(senders.map((sender) => sender.userId)).toEqual(['user-3', 'user-4', 'user-5', 'user-6', 'user-7']);
  });

  it('returns a short byline once unreadable rows outrun the cushion', () => {
    // Pinning the degraded shape, not endorsing it: one more unreadable row
    // than the cushion covers and the byline is short even though senders exist
    // below the fetch window. Widening the over-fetch is the knob if a real
    // `climbed_at` ever becomes unreadable — `climbed_at` is `timestamp NOT
    // NULL`, so today this costs nothing to leave as-is. What must not happen
    // silently is this turning into a throw or a padded/duplicated row.
    const rows = readableWindow(RECENT_CLIMB_SENDERS_FETCH_LIMIT);
    for (let index = 0; index <= RECENT_CLIMB_SENDERS_OVERFETCH; index += 1) {
      rows[index] = row(`corrupt-${index}`, 'not a timestamp');
    }

    const senders = toRecentSenders(rows);

    expect(senders).toHaveLength(RECENT_CLIMB_SENDERS_LIMIT - 1);
    expect(senders.map((sender) => sender.userId)).toEqual(['user-4', 'user-5', 'user-6', 'user-7']);
  });

  it('drops rows with a null or invalid Date timestamp', () => {
    const senders = toRecentSenders([
      row('null-row', null),
      row('invalid-date-row', new Date(Number.NaN)),
      row('date-row', new Date('2026-07-02T10:00:00.000Z')),
    ]);

    expect(senders.map((sender) => sender.userId)).toEqual(['date-row']);
    expect(senders[0].lastSentAt).toBe('2026-07-02T10:00:00.000Z');
  });
});
