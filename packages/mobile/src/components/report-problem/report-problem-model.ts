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
  pickReportAudience,
  reportNoteProblem,
  routeBoardReport,
  routeGymReport,
  type BoardReportReason,
  type GymListingState,
  type GymReportReason,
  type ReportAudience,
} from '@boardsesh/directory-moderation';
import { SYSTEM_BOARD_OWNER_ID, type DirectoryReportSubmitResult } from '@boardsesh/shared-schema';

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
