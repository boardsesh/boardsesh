import type { SessionDetail } from '@boardsesh/shared-schema';

/**
 * Whether the session-detail screen's edit pencil (rename + recap) should be
 * offered for `session` to the viewer `viewerUserId`.
 *
 * A `daily_highlight` session is reconstructed on the fly from that day's
 * ticks — it has no `board_sessions` row, so there is nothing for
 * `updateSession` to write to. Before #5290, this gate was ownership-only
 * (`ownerUserId === viewerUserId`), and a daily highlight always reports the
 * viewer as its own owner on their own feed — so the pencil rendered, the
 * climber typed a recap, and every save attempt failed with "Invalid input:
 * Session ID must be alphanumeric with hyphens only" (the synthetic
 * `daily:<user>:<date>` id sent as if it were a real session id), silently
 * discarding what they typed.
 *
 * Only a real (`party`) session — one the climber actually pressed Start
 * on, or a merge target — has a row `updateSession` can write to, so editing
 * stays scoped to `sessionType === 'party'` regardless of ownership.
 */
export function canEditSessionDetail(
  session: Pick<SessionDetail, 'sessionType' | 'ownerUserId'> | null | undefined,
  viewerUserId: string | null | undefined,
): boolean {
  if (!session || session.sessionType !== 'party') return false;
  if (!session.ownerUserId || !viewerUserId) return false;
  return session.ownerUserId === viewerUserId;
}
