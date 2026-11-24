import {
  BOARD_REPORT_REASONS_FOR_REPORTERS,
  GYM_REPORT_REASONS,
  isSetupSuggestionAllowed,
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
  initialSetupSelection,
  isSetupChanged,
  isSetupSelectionComplete,
  toSuggestedSetup,
  type SetupSelection,
  type SetupSelectionBoard,
} from '@boardsesh/board-config';
import { isBoardSetupUnchangedError } from '@boardsesh/graphql/errors';
import {
  SYSTEM_BOARD_OWNER_ID,
  type BoardSetupReviewReason,
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

/**
 * A board's setup as the page read it: its type, layout, size, hold sets,
 * angle and whether it tilts. What the "Set up wrong" fields start on.
 */
export type ReportBoardSetup = SetupSelectionBoard;

export type ReportBoardSubject = {
  uuid: string;
  name: string;
  /** Null when the creator's privacy keeps them back. */
  ownerId: string | null;
  /** Shown in the routing line when the server names the creator. */
  ownerDisplayName: string | null;
  /**
   * The board's current setup, for the "Set up wrong" fields. Null when the
   * page has none to hand: the dialog then offers the note only.
   */
  setup: ReportBoardSetup | null;
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
  /**
   * The setup picked in the "Set up wrong" fields, or null before the climber
   * touches one: the fields then show the board's current setup
   * ({@link draftSetupSelection}).
   */
  setup: SetupSelection | null;
};

export const EMPTY_REPORT_DRAFT: ReportDraft = {
  reason: null,
  duplicateBoardPick: null,
  duplicateGymUuid: null,
  note: '',
  setup: null,
};

/** The reasons the dialog lists, in the order the design lists them. */
export function reportReasonsFor(kind: ReportProblemTarget['kind']): readonly ReportReason[] {
  return kind === 'board' ? BOARD_REPORT_REASONS_FOR_REPORTERS : GYM_REPORT_REASONS;
}

/** Whether the note field is required for the chosen reason ("Something else"). */
export function noteIsRequired(reason: ReportReason | null): boolean {
  return reason === 'other';
}

/**
 * The board whose setup the "Set up wrong" fields edit, or null when the dialog
 * shows no fields: the `directory-setup-suggestions` flag is off, the reason is
 * not "Set up wrong", the board is a spray wall (`isSetupSuggestionAllowed`),
 * the page has no setup for it, or its board type is one this build doesn't know.
 */
export function setupFieldsBoard(
  target: ReportProblemTarget,
  reason: ReportReason | null,
  setupSuggestionsEnabled: boolean,
): ReportBoardSetup | null {
  if (!setupSuggestionsEnabled || target.kind !== 'board' || reason === null) return null;
  const setup = target.board.setup;
  if (!setup || !isSetupSuggestionAllowed(reason, setup.boardType)) return null;
  return initialSetupSelection(setup) === null ? null : setup;
}

/** What the fields show: the climber's pick, or the board's current setup before they pick. */
export function draftSetupSelection(draft: ReportDraft, setupBoard: ReportBoardSetup): SetupSelection | null {
  return draft.setup ?? initialSetupSelection(setupBoard);
}

/** The climber picked a whole setup (a layout, a size, at least one hold set) that differs from the board's. */
function hasSetupChange(draft: ReportDraft, setupBoard: ReportBoardSetup): boolean {
  const selection = draftSetupSelection(draft, setupBoard);
  return selection !== null && isSetupSelectionComplete(selection) && isSetupChanged(selection, setupBoard);
}

/**
 * Send is enabled once a reason is picked and its note passes the same check
 * the server runs. With the setup fields showing (`setupBoard`), the setup must
 * also differ from the board's: the server refuses a suggestion of the setup it
 * has now.
 */
export function canSendReport(draft: ReportDraft, setupBoard: ReportBoardSetup | null = null): boolean {
  if (draft.reason === null || reportNoteProblem(draft.reason, draft.note) !== null) return false;
  return setupBoard === null || hasSetupChange(draft, setupBoard);
}

/** A new reason clears what belonged to the old one, but keeps the note the climber typed. */
export function chooseReason(draft: ReportDraft, reason: ReportReason): ReportDraft {
  if (draft.reason === reason) return draft;
  return { ...draft, reason, duplicateBoardPick: null, duplicateGymUuid: null };
}

/** `setupBoard` is {@link setupFieldsBoard}'s answer: with it, the input carries the picked setup. */
export function buildReportBoardInput(
  boardUuid: string,
  draft: ReportDraft,
  setupBoard: ReportBoardSetup | null = null,
): ReportBoardInput | null {
  if (!canSendReport(draft, setupBoard) || draft.reason === null) return null;
  const reason = draft.reason as BoardReportReason;
  const pick = draft.duplicateBoardPick;
  const selection = setupBoard ? draftSetupSelection(draft, setupBoard) : null;
  const suggestedSetup = selection ? toSuggestedSetup(selection) : null;
  return {
    boardUuid,
    reason,
    duplicateOfBoardUuid:
      reason === 'duplicate' && pick !== null && pick !== NOT_SURE_DUPLICATE && pick !== boardUuid ? pick : null,
    note: normalizeReportNote(draft.note),
    ...(suggestedSetup ? { suggestedSetup } : {}),
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

/**
 * The line where the routing line was, once the setup fields show: what Send
 * will do with the suggestion, from the gym half of the server's rule
 * (`setupSuggestionPreview`). A limit the page can't see can still send it to
 * review; the done state says so.
 *
 * Null, for no line at all, when the board is at a gym whose listing state the
 * page couldn't read (the gym read failed): the rule would read that as no gym
 * and say the creator checks it first, while the server may apply it.
 */
export function setupPreviewFor(target: ReportProblemTarget): SetupSuggestionPreview | null {
  if (target.gym !== null && target.gym.listingState === null) return null;
  return setupSuggestionPreview({ hasGym: target.gym !== null, gymListingState: target.gym?.listingState ?? null });
}

/**
 * What the done state says. `setup_applied`: the suggestion changed the board
 * for everyone. `setup_review`: it waits for review, and why. A suggestion that
 * went to review with no reason (the server flag off) reads as any report.
 * `setup_unchanged`: the server refused the suggestion because the board
 * already has that setup ({@link sentMessageForError}).
 */
export type ReportSentMessage =
  | { kind: 'sent' }
  | { kind: 'joined'; count: number }
  | { kind: 'already' }
  | { kind: 'setup_applied' }
  | { kind: 'setup_review'; reason: BoardSetupReviewReason }
  | { kind: 'setup_unchanged' };

export function sentMessageFor(
  result: Pick<DirectoryReportSubmitResult, 'status' | 'otherReporterCount' | 'setupOutcome' | 'setupReviewReason'>,
): ReportSentMessage {
  if (result.setupOutcome === 'APPLIED') return { kind: 'setup_applied' };
  if (result.setupOutcome === 'SENT_FOR_REVIEW' && result.setupReviewReason) {
    return { kind: 'setup_review', reason: result.setupReviewReason };
  }
  if (result.status === 'already_reported') return { kind: 'already' };
  if (result.status === 'added' && result.otherReporterCount > 0) {
    return { kind: 'joined', count: result.otherReporterCount };
  }
  return { kind: 'sent' };
}

/**
 * A failed send that still ends in the done state, or null for a real failure.
 * The server refuses a suggestion of the setup the board has now
 * (`isBoardSetupUnchangedError`): the page read the board before someone fixed
 * it. The board is already right, so the dialog says so instead of an error
 * the climber can't get past.
 */
export function sentMessageForError(error: unknown): ReportSentMessage | null {
  return isBoardSetupUnchangedError(error) ? { kind: 'setup_unchanged' } : null;
}

/** A failed send: no connection, or anything else. Never the server's English. */
export function reportErrorKind(online: boolean): 'offline' | 'error' {
  return online ? 'error' : 'offline';
}

/**
 * Whether the report dialog starts from a clean draft: when it opens, or when
 * the target changes from one real target to another. A target that goes null
 * (the page re-reading it, a token rotation) and comes back the same keeps the
 * draft and any sent message.
 */
export function shouldResetReportDialog(
  previous: { open: boolean; targetKey: string | null },
  next: { open: boolean; targetKey: string | null },
): boolean {
  if (!next.open) return false;
  if (!previous.open) return true;
  return previous.targetKey !== null && next.targetKey !== null && previous.targetKey !== next.targetKey;
}
