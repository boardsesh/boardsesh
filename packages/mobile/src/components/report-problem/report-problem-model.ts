// What "Report a problem" decides before anything renders: who may see the
// entry point, who the report reaches, and what the sheet says when it went
// through. Pure, so a table test pins every branch without a sheet.
//
// Routing comes from `@boardsesh/directory-moderation`, the same functions the
// backend routes with, so the sheet's "who will see this" line never promises a
// reader the server won't reach (docs/product/directory-reports.md).

import {
  BOARD_REPORT_REASONS_FOR_REPORTERS,
  GYM_REPORT_REASONS,
  OTHER_REASON_NOTE_MIN_LENGTH,
  SETUP_SUGGESTION_REPORT_REASON,
  normalizeReportNote,
  pickReportAudience,
  reportNoteProblem,
  routeBoardReport,
  routeGymReport,
  setupSuggestionPreview,
  type BoardReportReason,
  type GymListingState,
  type GymReportReason,
  type ReportAudience,
  type SetupSuggestionPreview,
} from '@boardsesh/directory-moderation';
import {
  SYSTEM_BOARD_OWNER_ID,
  type BoardSetupReviewReason,
  type DirectoryReportSubmitResult,
} from '@boardsesh/shared-schema';

/** The reasons a climber picks from, in sheet order. */
export const BOARD_REASONS: readonly BoardReportReason[] = BOARD_REPORT_REASONS_FOR_REPORTERS;
export const GYM_REASONS: readonly GymReportReason[] = GYM_REPORT_REASONS;

/** The "Not sure" answer to "Which board is the same wall?". */
export const DUPLICATE_NOT_SURE = 'not_sure';

/** The board fields the entry-point rule reads. */
export type ReportableBoard = {
  ownerId?: string | null;
  canEdit?: boolean;
  canDelete?: boolean;
  canRemoveFromGym?: boolean;
};

/**
 * Whether the viewer can fix this board themselves: they added it, or the
 * server lets them edit, remove or delete it (gym staff, moderators). Those
 * viewers get the fix actions instead of "Report a problem".
 */
export function viewerCanFixBoard(board: ReportableBoard, viewerUserId: string | null): boolean {
  if (viewerUserId !== null && board.ownerId === viewerUserId) return true;
  return board.canEdit === true || board.canDelete === true || board.canRemoveFromGym === true;
}

/** Whether "Report a problem" is offered for this board. */
export function canReportBoard(
  board: ReportableBoard,
  { enabled, viewerUserId }: { enabled: boolean; viewerUserId: string | null },
): boolean {
  return enabled && !viewerCanFixBoard(board, viewerUserId);
}

/** Whether "Report a problem" is offered for this gym: anyone who can't edit it. */
export function canReportGym(gym: { canEdit?: boolean }, { enabled }: { enabled: boolean }): boolean {
  return enabled && gym.canEdit !== true;
}

export type BoardAudienceInput = {
  board: { ownerId?: string | null; ownerDisplayName?: string | null; gymUuid?: string | null };
  /** The picked reason. Before one is picked, the line reads as for "Set up wrong". */
  reason: BoardReportReason | null;
  viewerUserId: string | null;
  /** The board's gym listing state, once the gym has loaded. */
  gymListingState: GymListingState | null;
};

/** Who will see a board report, as an audience id the sheet words with a literal `t()`. */
export function boardReportAudience(input: BoardAudienceInput): ReportAudience {
  const reason = input.reason ?? 'wrong_setup';
  const boardOwnedBySystem = input.board.ownerId === SYSTEM_BOARD_OWNER_ID;
  const hasGym = !!input.board.gymUuid;
  const gymListingState = hasGym ? input.gymListingState : null;
  const routing = routeBoardReport({
    reason,
    boardOwnedBySystem,
    viewerIsCreator: input.viewerUserId !== null && input.board.ownerId === input.viewerUserId,
    hasGym,
    gymListingState,
  });
  return pickReportAudience({
    targetKind: 'board',
    recipients: routing.recipients,
    creatorNameVisible: !boardOwnedBySystem && !!input.board.ownerDisplayName,
    gymListingState,
  });
}

/** Who will see a gym report. */
export function gymReportAudience(reason: GymReportReason | null, gymListingState: GymListingState): ReportAudience {
  const routing = routeGymReport({ reason: reason ?? 'duplicate', gymListingState });
  return pickReportAudience({
    targetKind: 'gym',
    recipients: routing.recipients,
    creatorNameVisible: false,
    gymListingState,
  });
}

/**
 * "Run {{gym}}? Claim it and fix it yourself." under the routing line: for a
 * gym nobody runs yet that the viewer may claim.
 */
export function showClaimNudge(
  gym: { canClaim?: boolean; listingState?: GymListingState } | null | undefined,
): boolean {
  return !!gym && gym.canClaim === true && gym.listingState !== 'RUN_BY_GYM';
}

/** Whether Send is enabled: a reason, and a note the server will take for it. */
export function canSendReport(reason: string | null, note: string): boolean {
  return reason !== null && reportNoteProblem(reason, note) === null;
}

/** Which done line the sheet shows. */
export type ReportDoneCopy = { kind: 'sent' } | { kind: 'joined'; count: number } | { kind: 'already_reported' };

export function reportDoneCopy(
  result: Pick<DirectoryReportSubmitResult, 'status' | 'otherReporterCount'>,
): ReportDoneCopy {
  if (result.status === 'already_reported') return { kind: 'already_reported' };
  if (result.status === 'added' && result.otherReporterCount > 0) {
    return { kind: 'joined', count: result.otherReporterCount };
  }
  return { kind: 'sent' };
}

/**
 * Whether Send is enabled on "Set up wrong" while the setup fields show: the
 * climber picked a setup that differs from the board's, or, with the setup
 * left as it is, wrote a note long enough to act on (the "Something else"
 * minimum, {@link OTHER_REASON_NOTE_MIN_LENGTH}). A note is never too long.
 */
export function canSendSetupReport({ setupChanged, note }: { setupChanged: boolean; note: string }): boolean {
  if (reportNoteProblem(SETUP_SUGGESTION_REPORT_REASON, note) !== null) return false;
  if (setupChanged) return true;
  return (normalizeReportNote(note)?.length ?? 0) >= OTHER_REASON_NOTE_MIN_LENGTH;
}

/**
 * The line under Send while a changed setup is picked: what happens to it,
 * worded from the gym's listing state, the half of the server's rule a client
 * can see. Null while the board's gym state is unknown (still loading, or its
 * read failed), and the sheet then shows no line at all: never "whoever added
 * it" about a board that has a gym, nor the report's routing line, which says
 * who reads a report rather than what happens to the setup.
 */
export function setupSuggestionLine({
  boardGymUuid,
  gymListingState,
}: {
  boardGymUuid: string | null;
  gymListingState: GymListingState | null;
}): SetupSuggestionPreview | null {
  if (boardGymUuid && gymListingState === null) return null;
  return setupSuggestionPreview({ hasGym: !!boardGymUuid, gymListingState });
}

/**
 * The done step for a report that carried a suggested setup:
 * - `applied`: it changed the board for everyone; the sheet offers "Climb it
 *   now". The result's `board` is null when the change committed but the
 *   server couldn't read the board back; the sheet reads it by uuid, and the
 *   change still stands.
 * - `review`: it waits for someone, and `reason` says why.
 * - null: no suggestion, or the `directory-setup-suggestions` flag is off on
 *   the server (`SENT_FOR_REVIEW` with no reason): the plain done line.
 */
export type SetupDoneCopy = { kind: 'applied' } | { kind: 'review'; reason: BoardSetupReviewReason };

export function setupDoneCopy(
  result: Pick<DirectoryReportSubmitResult, 'setupOutcome' | 'setupReviewReason'>,
): SetupDoneCopy | null {
  if (result.setupOutcome === 'APPLIED') return { kind: 'applied' };
  if (result.setupOutcome === 'SENT_FOR_REVIEW' && result.setupReviewReason) {
    return { kind: 'review', reason: result.setupReviewReason };
  }
  return null;
}
