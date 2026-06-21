import { and, eq } from 'drizzle-orm';
import { roomManager } from '../services/room-manager';
import { db } from '../db/client';
import { boardSessionParticipants } from '../db/schema';

export type WidgetSessionGuardResult = { ok: true } | { ok: false; status: 410 | 403; error: string };

/**
 * Gate widget REST writes (`/api/widget/navigate`, `/api/widget/take-control`)
 * AFTER auth + rate-limit but BEFORE any queue read/mutation.
 *
 * Always-live removed the old driver gate, which previously failed closed once
 * a session's Redis driver key was gone. Without a replacement, a stale Live
 * Activity push-token row (`activity_push_tokens` survives session end / leave)
 * could:
 *   - revive an ENDED session: a widget write falls back to the persisted queue
 *     and re-publishes `CurrentClimbChanged`, writing fresh Redis/Postgres state
 *     for a durably-ended session — the severe case this guard kills, and
 *   - drive a session the token's user was never part of.
 *
 * Membership is checked against the DURABLE `board_session_participants` record
 * ("ever joined"), NOT the live WebSocket roster: the Live Activity exists
 * precisely for the locked/backgrounded state where the JS WebSocket is
 * suspended, so requiring a live connection would wrongly reject a legitimate
 * member with a locked phone. Note this durable record is never removed on
 * leave, so it does not distinguish a member who explicitly left a still-active
 * session — an accepted minor surface, far less severe than reviving an ended
 * session, and with no clean signal that wouldn't also reject locked phones.
 *
 * `userId` may be null for legacy anonymous token rows; those get the
 * ended-session check only (there is no user to match against participants).
 */
export async function verifyWidgetSession(sessionId: string, userId: string | null): Promise<WidgetSessionGuardResult> {
  // Durable session lookup (Postgres row, not Redis — an ended session's Redis
  // state is deleted, but the row persists with status='ended'/endedAt set).
  const session = await roomManager.getSessionById(sessionId);
  if (!session || session.status === 'ended' || session.endedAt != null) {
    // 410 mirrors the widget handlers' existing "token stale; re-register" path.
    return { ok: false, status: 410, error: 'Session has ended; re-register' };
  }

  if (userId) {
    const rows = await db
      .select({ sessionId: boardSessionParticipants.sessionId })
      .from(boardSessionParticipants)
      .where(and(eq(boardSessionParticipants.userId, userId), eq(boardSessionParticipants.sessionId, sessionId)))
      .limit(1);
    if (rows.length === 0) {
      return { ok: false, status: 403, error: 'Not a participant in this session' };
    }
  }

  return { ok: true };
}
