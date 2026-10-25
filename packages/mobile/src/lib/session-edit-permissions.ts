import type { SessionDetail } from '@boardsesh/shared-schema';

/** Daily groups are feed keys (`daily:<userId>:<date>`), not `board_sessions` rows. */
export function isDailySessionId(sessionId: string | null | undefined): boolean {
  return !!sessionId && sessionId.startsWith('daily:');
}

/**
 * Whether the detail screen offers the edit pencil. A daily group reports the
 * viewer as its owner but has no row for `updateSession` to write to, so only
 * a real (`party`) session the viewer owns can be edited.
 */
export function canEditSessionDetail(
  session: Pick<SessionDetail, 'sessionType' | 'ownerUserId'> | null | undefined,
  viewerUserId: string | null | undefined,
): boolean {
  if (!session || session.sessionType !== 'party') return false;
  if (!session.ownerUserId || !viewerUserId) return false;
  return session.ownerUserId === viewerUserId;
}
