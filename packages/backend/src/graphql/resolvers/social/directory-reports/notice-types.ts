import type { NotificationType } from '@boardsesh/shared-schema';

/**
 * The notification types the directory reports feature sends
 * (docs/product/directory-reports.md, "Notifications"). Kept apart from
 * notices.ts so the inbox privacy rule can name them without importing the
 * sending side.
 */
export const DIRECTORY_NOTICE_TYPES = [
  'board_report_opened',
  'board_report_resolved',
  'board_removed_from_gym',
  'board_deleted_by_staff',
  'board_edited_by_staff',
  'gym_report_opened',
  'gym_report_resolved',
  // The claim notices (docs/product/gym-claims.md). Their entity is the gym.
  'gym_claimed_with_your_board',
  'gym_claim_denied',
  // A climber's suggested setup changed the creator's board
  // (docs/product/directory-reports.md, "Suggested setup").
  'board_setup_changed_by_climber',
] as const satisfies readonly NotificationType[];
export type DirectoryNoticeType = (typeof DIRECTORY_NOTICE_TYPES)[number];

export function isDirectoryNoticeType(type: string): type is DirectoryNoticeType {
  return (DIRECTORY_NOTICE_TYPES as readonly string[]).includes(type);
}
