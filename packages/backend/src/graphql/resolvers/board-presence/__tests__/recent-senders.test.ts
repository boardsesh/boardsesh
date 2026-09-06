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

/** A window of `count` rows as Postgres hands them back: newest-first, all readable. */
function readableWindow(count: number): RecentSenderRow[] {
  return Array.from({ length: count }, (_, index) => {
    const day = String(index + 1).padStart(2, '0');
    return row(`user-${index}`, `2026-07-${day} 10:00:00`);
  });
}

describe('toRecentSenders', () => {
  it('normalizes an unzoned Postgres timestamp to UTC and caps at the byline limit', () => {
    const senders = toRecentSenders(readableWindow(RECENT_CLIMB_SENDERS_FETCH_LIMIT));

    expect(senders).toHaveLength(RECENT_CLIMB_SENDERS_LIMIT);
    expect(senders.map((sender) => sender.userId)).toEqual(['user-0', 'user-1', 'user-2', 'user-3', 'user-4']);
    expect(senders[0].lastSentAt).toBe('2026-07-01T10:00:00.000Z');
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
