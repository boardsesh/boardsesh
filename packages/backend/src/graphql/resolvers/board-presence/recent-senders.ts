// Row-shaping for the wall-kiosk "recent senders" byline. Kept out of
// `queries.ts` so the over-fetch/slice contract below can be pinned by a plain
// unit test — the degraded case needs a `climbed_at` Postgres cannot produce
// through a `timestamp NOT NULL` column, so it is unreachable from the
// integration suite.

import type { BoardClimbRecentSender } from '@boardsesh/shared-schema';
import { parsePostgresUtcTimestamp } from '../../../utils/postgres-timestamps';

/** Distinct climbers the byline renders. */
export const RECENT_CLIMB_SENDERS_LIMIT = 5;

/**
 * Spare rows asked of Postgres on top of the limit.
 *
 * Postgres applies the LIMIT, then `toRecentSenders` drops any row whose
 * `climbed_at` will not parse — so asking for exactly 5 would hand back 4
 * whenever a corrupt row landed in the top 5, with valid senders sitting just
 * under the cut and no way to reach them.
 *
 * This is a cushion, not a guarantee: with more than this many unreadable rows
 * in the fetched window the byline is short even though valid senders exist
 * below rank {@link RECENT_CLIMB_SENDERS_FETCH_LIMIT}. Three is sized for a
 * column that is `timestamp NOT NULL` — every row Postgres returns parses, so
 * the cushion only ever spends itself on a driver/serialisation fault, and
 * paging further for one is not worth the extra rows on every kiosk refresh.
 * `recent-senders.test.ts` pins both sides of that edge.
 */
export const RECENT_CLIMB_SENDERS_OVERFETCH = 3;

export const RECENT_CLIMB_SENDERS_FETCH_LIMIT = RECENT_CLIMB_SENDERS_LIMIT + RECENT_CLIMB_SENDERS_OVERFETCH;

/** One grouped `boardsesh_ticks` row: a distinct climber and their latest send. */
export type RecentSenderRow = {
  userId: string;
  senderName: string | null;
  senderImage: string | null;
  profileDisplayName: string | null;
  profileAvatarUrl: string | null;
  lastSentAt: string | Date | null;
};

/**
 * Map grouped tick rows (already newest-first) to byline senders, dropping any
 * row with an unreadable `lastSentAt` and capping at
 * {@link RECENT_CLIMB_SENDERS_LIMIT}.
 *
 * Profile fields win over the auth-account name/image, matching the
 * attribution precedence in `reportBoardClimb`.
 */
export function toRecentSenders(rows: readonly RecentSenderRow[]): BoardClimbRecentSender[] {
  const senders = rows.flatMap((row) => {
    const lastSentAt = parsePostgresUtcTimestamp(row.lastSentAt);
    return lastSentAt
      ? [
          {
            userId: row.userId,
            displayName: row.profileDisplayName ?? row.senderName ?? null,
            avatarUrl: row.profileAvatarUrl ?? row.senderImage ?? null,
            lastSentAt,
          },
        ]
      : [];
  });
  return senders.slice(0, RECENT_CLIMB_SENDERS_LIMIT);
}
