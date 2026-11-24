/**
 * The vocabulary of a directory report: what was reported, why, where it stands
 * and who it goes to (docs/product/directory-reports.md). The strings are the
 * database enum values and the GraphQL enum values alike, so a client can pass
 * them straight through.
 */

/** What a report is about. */
export const DIRECTORY_REPORT_TARGET_KINDS = ['board', 'gym'] as const;
export type DirectoryReportTargetKind = (typeof DIRECTORY_REPORT_TARGET_KINDS)[number];

/**
 * Why a climber reported a board. `relist_request` is not a reporter's reason:
 * only the board's creator files it, on their own board, after gym staff took
 * it off their listing. It is kept apart in {@link BOARD_REPORT_REASONS_FOR_REPORTERS}.
 */
export const BOARD_REPORT_REASONS = [
  'wrong_setup',
  'duplicate',
  'gone',
  'wrong_place',
  'other',
  'relist_request',
] as const;
export type BoardReportReason = (typeof BOARD_REPORT_REASONS)[number];

/** The board reasons a reporter picks from, in the order the report sheet lists them. */
export const BOARD_REPORT_REASONS_FOR_REPORTERS = ['wrong_setup', 'duplicate', 'gone', 'wrong_place', 'other'] as const;

/** Board reasons only the board's creator may file. */
export const CREATOR_ONLY_BOARD_REPORT_REASONS = ['relist_request'] as const;

/** Why a climber reported a gym listing, in the order the report sheet lists them. */
export const GYM_REPORT_REASONS = ['duplicate', 'closed', 'wrong_details', 'not_a_gym', 'other'] as const;
export type GymReportReason = (typeof GYM_REPORT_REASONS)[number];

/** Every reason, board and gym, as one set: the database enum. */
export const DIRECTORY_REPORT_REASONS = [
  'wrong_setup',
  'duplicate',
  'gone',
  'wrong_place',
  'other',
  'relist_request',
  'closed',
  'wrong_details',
  'not_a_gym',
] as const;
export type DirectoryReportReason = (typeof DIRECTORY_REPORT_REASONS)[number];

/**
 * Where a report stands. `open` and `escalated` are still waiting on someone;
 * every other status is an outcome and never changes again.
 *
 * - `escalated`: in the Boardsesh admin queue, either straight away (routed to
 *   admin) or after {@link ESCALATE_AFTER_DAYS} days without an outcome.
 * - `fixed`: the board or gym was corrected (an edit, or staff re-listing a board).
 * - `removed`: the board came off the gym, or the gym came off the map.
 * - `deleted`: the board or gym was deleted.
 * - `kept`: someone who can act looked and kept it as it is.
 * - `merged`: it was folded into another board or gym.
 */
export const DIRECTORY_REPORT_STATUSES = [
  'open',
  'escalated',
  'fixed',
  'removed',
  'deleted',
  'kept',
  'merged',
] as const;
export type DirectoryReportStatus = (typeof DIRECTORY_REPORT_STATUSES)[number];

/** Statuses still waiting on someone. One such report may exist per target and reason. */
export const OPEN_DIRECTORY_REPORT_STATUSES = ['open', 'escalated'] as const;
export type OpenDirectoryReportStatus = (typeof OPEN_DIRECTORY_REPORT_STATUSES)[number];

/** Outcomes: a report in one of these is closed for good. */
export const RESOLVED_DIRECTORY_REPORT_STATUSES = ['fixed', 'removed', 'deleted', 'kept', 'merged'] as const;
export type DirectoryReportOutcome = (typeof RESOLVED_DIRECTORY_REPORT_STATUSES)[number];

/** Who a report goes to. `gym_staff` means the gym's owner and admin members. */
export const DIRECTORY_REPORT_RECIPIENTS = ['creator', 'gym_staff', 'admin'] as const;
export type DirectoryReportRecipient = (typeof DIRECTORY_REPORT_RECIPIENTS)[number];

/**
 * Who closed a report. `auto` is the system: the merge tool, or a sweep that
 * found the target gone. `climber` is a climber whose suggested setup changed
 * the board at a gym nobody runs (`setupSuggestionDecision`).
 */
export const DIRECTORY_REPORT_RESOLVER_ROLES = ['creator', 'gym_staff', 'admin', 'auto', 'climber'] as const;
export type DirectoryReportResolverRole = (typeof DIRECTORY_REPORT_RESOLVER_ROLES)[number];

/**
 * Gym listing state, as `Gym.listingState` reports it (docs/product/gym-board-governance.md,
 * decision 4). Repeated here so this package needs nothing from the schema package.
 */
export type GymListingState = 'UNCLAIMED' | 'CLIMBER_LISTED' | 'RUN_BY_GYM';

export function isBoardReportReason(value: string): value is BoardReportReason {
  return (BOARD_REPORT_REASONS as readonly string[]).includes(value);
}

export function isGymReportReason(value: string): value is GymReportReason {
  return (GYM_REPORT_REASONS as readonly string[]).includes(value);
}

export function isCreatorOnlyBoardReportReason(reason: string): reason is 'relist_request' {
  return (CREATOR_ONLY_BOARD_REPORT_REASONS as readonly string[]).includes(reason);
}

export function isOpenDirectoryReportStatus(status: string): status is OpenDirectoryReportStatus {
  return (OPEN_DIRECTORY_REPORT_STATUSES as readonly string[]).includes(status);
}

export function isDirectoryReportOutcome(status: string): status is DirectoryReportOutcome {
  return (RESOLVED_DIRECTORY_REPORT_STATUSES as readonly string[]).includes(status);
}
