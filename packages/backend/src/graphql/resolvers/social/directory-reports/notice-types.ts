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
] as const satisfies readonly NotificationType[];
export type DirectoryNoticeType = (typeof DIRECTORY_NOTICE_TYPES)[number];

export function isDirectoryNoticeType(type: string): type is DirectoryNoticeType {
  return (DIRECTORY_NOTICE_TYPES as readonly string[]).includes(type);
}
