import {
  BOARD_REPORT_REASONS_FOR_REPORTERS,
  GYM_REPORT_REASONS,
  normalizeReportNote,
  pickReportAudience,
  reportNoteProblem,
  routeBoardReport,
  routeGymReport,
  type BoardReportReason,
  type GymListingState,
  type GymReportReason,
  type ReportAudience,
} from '@boardsesh/directory-moderation';
import {
  SYSTEM_BOARD_OWNER_ID,
  type DirectoryReportSubmitResult,
  type ReportBoardInput,
  type ReportGymInput,
} from '@boardsesh/shared-schema';

/**
 * The Report a problem dialog's rules, kept out of the component so they can be
 * read and tested on their own (docs/product/directory-reports.md). Routing,
 * reasons and the note rules come from `@boardsesh/directory-moderation`, the
 * same code the backend routes and validates with.
 */

/** The gym a report is about, or the gym a reported board is at. */
export type ReportGymSubject = {
  uuid: string;
  name: string;
  /** For the claim nudge's link; null for a slug-less legacy gym. */
  slug: string | null;
  /** Null when the page could not read it: the routing line then assumes nobody runs the gym. */
  listingState: GymListingState | null;
  /** The viewer may claim this gym (`Gym.canClaim`). */
  canClaim: boolean;
  latitude?: number | null;
  longitude?: number | null;
};

export type ReportBoardSubject = {
  uuid: string;
  name: string;
  /** Null when the creator's privacy keeps them back. */
  ownerId: string | null;
  /** Shown in the routing line when the server names the creator. */
  ownerDisplayName: string | null;
};

/** Another board at the same gym, for "Which board is the same wall?". */
export type DuplicateBoardOption = { uuid: string; label: string };

export type ReportProblemTarget =
  | {
      kind: 'board';
      board: ReportBoardSubject;
      gym: ReportGymSubject | null;
      otherBoards: DuplicateBoardOption[];
    }
  | { kind: 'gym'; gym: ReportGymSubject };

export type ReportReason = BoardReportReason | GymReportReason;

/** "Not sure" in the duplicate picker: report the duplicate without naming the other board. */
export const NOT_SURE_DUPLICATE = 'not_sure';

/** What the climber has filled in so far. */
export type ReportDraft = {
  reason: ReportReason | null;
  /** The other board's uuid, {@link NOT_SURE_DUPLICATE}, or null before a pick. */
  duplicateBoardPick: string | null;
  /** The other gym listing's uuid, or null. */
  duplicateGymUuid: string | null;
  note: string;
};

export const EMPTY_REPORT_DRAFT: ReportDraft = {
  reason: null,
  duplicateBoardPick: null,
  duplicateGymUuid: null,
  note: '',
};

/** The reasons the dialog lists, in the order the design lists them. */
export function reportReasonsFor(kind: ReportProblemTarget['kind']): readonly ReportReason[] {
  return kind === 'board' ? BOARD_REPORT_REASONS_FOR_REPORTERS : GYM_REPORT_REASONS;
}

/** Whether the note field is required for the chosen reason ("Something else"). */
export function noteIsRequired(reason: ReportReason | null): boolean {
  return reason === 'other';
}

/** Send is enabled once a reason is picked and its note passes the same check the server runs. */
export function canSendReport(draft: ReportDraft): boolean {
  return draft.reason !== null && reportNoteProblem(draft.reason, draft.note) === null;
}

/** A new reason clears what belonged to the old one, but keeps the note the climber typed. */
export function chooseReason(draft: ReportDraft, reason: ReportReason): ReportDraft {
  if (draft.reason === reason) return draft;
  return { ...draft, reason, duplicateBoardPick: null, duplicateGymUuid: null };
}

export function buildReportBoardInput(boardUuid: string, draft: ReportDraft): ReportBoardInput | null {
  if (!canSendReport(draft) || draft.reason === null) return null;
  const reason = draft.reason as BoardReportReason;
  const pick = draft.duplicateBoardPick;
  return {
    boardUuid,
    reason,
    duplicateOfBoardUuid:
      reason === 'duplicate' && pick !== null && pick !== NOT_SURE_DUPLICATE && pick !== boardUuid ? pick : null,
    note: normalizeReportNote(draft.note),
  };
}

export function buildReportGymInput(gymUuid: string, draft: ReportDraft): ReportGymInput | null {
  if (!canSendReport(draft) || draft.reason === null) return null;
  const reason = draft.reason as GymReportReason;
  const other = draft.duplicateGymUuid;
  return {
    gymUuid,
    reason,
    duplicateOfGymUuid: reason === 'duplicate' && other !== null && other !== gymUuid ? other : null,
    note: normalizeReportNote(draft.note),
  };
}

/**
 * Who the routing line says will read the report, from the same routing the
 * server uses. Before a reason is picked it words the common case: a board as
 * "set up wrong", a gym as "listed twice".
 */
export function reportAudienceFor(
  target: ReportProblemTarget,
  reason: ReportReason | null,
  viewerUserId: string | null,
): ReportAudience {
  if (target.kind === 'gym') {
    const routing = routeGymReport({
      reason: (reason as GymReportReason | null) ?? 'duplicate',
      // An unknown state routes like an unclaimed gym: to the team.
      gymListingState: target.gym.listingState ?? 'UNCLAIMED',
    });
    return pickReportAudience({
      targetKind: 'gym',
      recipients: routing.recipients,
      creatorNameVisible: false,
      gymListingState: target.gym.listingState,
    });
  }
  const { board, gym } = target;
  const boardOwnedBySystem = board.ownerId === SYSTEM_BOARD_OWNER_ID;
  const routing = routeBoardReport({
    reason: (reason as BoardReportReason | null) ?? 'wrong_setup',
    boardOwnedBySystem,
    viewerIsCreator: viewerUserId !== null && board.ownerId === viewerUserId,
    hasGym: gym !== null,
    gymListingState: gym?.listingState ?? null,
  });
  return pickReportAudience({
    targetKind: 'board',
    recipients: routing.recipients,
    creatorNameVisible: !boardOwnedBySystem && Boolean(board.ownerDisplayName),
    gymListingState: gym?.listingState ?? null,
  });
}

/** The gym whose claim the dialog offers: one the viewer can claim and nobody runs yet. */
export function claimNudgeGym(target: ReportProblemTarget): ReportGymSubject | null {
  const gym = target.gym;
  if (!gym || !gym.canClaim || gym.listingState === 'RUN_BY_GYM') return null;
  return gym;
}

/** What the done state says. */
export type ReportSentMessage = { kind: 'sent' } | { kind: 'joined'; count: number } | { kind: 'already' };

export function sentMessageFor(
  result: Pick<DirectoryReportSubmitResult, 'status' | 'otherReporterCount'>,
): ReportSentMessage {
  if (result.status === 'already_reported') return { kind: 'already' };
  if (result.status === 'added' && result.otherReporterCount > 0) {
    return { kind: 'joined', count: result.otherReporterCount };
  }
  return { kind: 'sent' };
}

/** A failed send: no connection, or anything else. Never the server's English. */
export function reportErrorKind(online: boolean): 'offline' | 'error' {
  return online ? 'error' : 'offline';
}
