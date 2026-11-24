// Where tapping a directory notice goes (Report a problem, staff actions on
// boards; docs/product/directory-reports.md). Pure, so a table test pins every
// type without a router.

import type { GroupedNotification } from '@boardsesh/shared-schema';

export type DirectoryNoticeRoute =
  /** The board picker on the board's report review sheet. */
  | { kind: 'review'; boardUuid: string }
  /**
   * The board picker on the board's detail sheet. `relistGym` (a gym's staff
   * took the board off) offers its creator "Ask {{gym}} to list it again".
   */
  | { kind: 'board'; boardUuid: string; relistGym: { uuid: string; name: string | null } | null }
  /** The gym's edit route: staff fix the details a climber flagged. */
  | { kind: 'gym_edit'; gymUuid: string }
  /** The gym's page on the claimant's denial card, which offers the claim again. */
  | { kind: 'gym_claim_denied'; gymUuid: string }
  /** Nothing to open: a short explanation instead. */
  | { kind: 'explain'; explanation: 'board_deleted' | 'claim_denied'; name: string | null };

const DIRECTORY_NOTICE_TYPES: ReadonlySet<GroupedNotification['type']> = new Set([
  'board_report_opened',
  'board_report_resolved',
  'board_removed_from_gym',
  'board_deleted_by_staff',
  'board_edited_by_staff',
  'gym_report_opened',
  'gym_report_resolved',
  'gym_claimed_with_your_board',
  'gym_claim_denied',
  'board_setup_changed_by_climber',
]);

export function isDirectoryNoticeType(type: GroupedNotification['type']): boolean {
  return DIRECTORY_NOTICE_TYPES.has(type);
}

/**
 * Null when the row has nowhere to go: the climber reads its sentence, the tap
 * marks it read. The board or gym comes from `directoryNotice`, or from the
 * row's entity, which the backend sets to the same board or gym.
 */
export function directoryNoticeRoute(
  notification: Pick<GroupedNotification, 'type' | 'entityType' | 'entityId' | 'gymName' | 'directoryNotice'>,
): DirectoryNoticeRoute | null {
  const notice = notification.directoryNotice ?? null;
  const boardUuid = notice?.boardUuid ?? (notification.entityType === 'board' ? (notification.entityId ?? null) : null);
  const gymUuid = notice?.gymUuid ?? (notification.entityType === 'gym' ? (notification.entityId ?? null) : null);
  const gymName = notice?.gymName ?? notification.gymName ?? null;
  switch (notification.type) {
    case 'board_report_opened':
      // Reminders and relist requests too: the review sheet is where they're answered.
      return boardUuid ? { kind: 'review', boardUuid } : null;
    case 'board_report_resolved':
      // A deleted board has nothing left to open.
      if (notice?.outcome === 'deleted') return null;
      return boardUuid ? { kind: 'board', boardUuid, relistGym: null } : null;
    case 'board_removed_from_gym':
      if (!boardUuid) return null;
      // A relist request goes to the staff of the gym that removed the board,
      // so it is offered only when that gym's staff did it. A moderator's
      // removal is not theirs to undo, and a notice without its gym has no
      // one to ask.
      return {
        kind: 'board',
        boardUuid,
        relistGym: notice?.actorRole === 'gym_staff' && notice.gymUuid ? { uuid: notice.gymUuid, name: gymName } : null,
      };
    case 'board_edited_by_staff':
    case 'gym_claimed_with_your_board':
    case 'board_setup_changed_by_climber':
      return boardUuid ? { kind: 'board', boardUuid, relistGym: null } : null;
    case 'board_deleted_by_staff':
      return { kind: 'explain', explanation: 'board_deleted', name: notice?.boardName ?? null };
    case 'gym_report_opened':
      return gymUuid ? { kind: 'gym_edit', gymUuid } : null;
    case 'gym_claim_denied':
      // A notice that lost its gym can only be explained.
      return gymUuid
        ? { kind: 'gym_claim_denied', gymUuid }
        : { kind: 'explain', explanation: 'claim_denied', name: gymName };
    default:
      return null;
  }
}
