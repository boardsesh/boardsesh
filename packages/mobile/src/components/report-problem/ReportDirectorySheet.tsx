// "Report a problem" for a board or a gym listing (design §3a). The climber
// picks what's wrong; for "Listed twice" on a board they can name the other
// board at the same gym; a note is optional except for "Something else". The
// foot says who will see it, worded from the same routing the server uses,
// and on a gym nobody runs yet offers the claim instead.
//
// "Set up wrong" on a board also offers the setup itself (the
// `directory-setup-suggestions` flag; docs/product/directory-reports.md,
// "Suggested setup"): Layout, Size, Holds and Angle menus that open on the
// board's current setup. At a gym nobody runs the change applies for everyone,
// and the done step offers "Climb it now" in this same sheet, never a second one.
// So does a suggestion the server refuses because the board already has it
// (someone fixed it while this sheet was open): there is nothing to change, but
// the right setup is there to climb.
//
// The builder's near-miss "Use it and fix its setup" (#8151) opens it on "Set
// up wrong" with the climber's own setup already in the fields
// (`initialReason`, `initialSetup`), or written into the note while the setup
// fields are off. Nothing is sent until the climber taps Send.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  initialSetupSelection,
  isSetupChanged,
  isSetupSelectionComplete,
  normaliseSetIds,
  setupSelectionReducer,
  toSuggestedSetup,
  type SetupSelection,
  type SetupSelectionAction,
} from '@boardsesh/board-config';
import {
  OTHER_REASON_NOTE_MIN_LENGTH,
  REPORT_NOTE_MAX_LENGTH,
  SETUP_CHANGE_BOARD_COOLDOWN_HOURS,
  SETUP_CHANGE_REVIEW_DAYS_AFTER_UNDO,
  SETUP_CHANGES_PER_CLIMBER_PER_DAY,
  isSetupSuggestionAllowed,
  normalizeReportNote,
  type BoardReportReason,
  type GymReportReason,
  type ReportAudience,
  type SetupSuggestionPreview,
} from '@boardsesh/directory-moderation';
import { isBoardSetupUnchangedError } from '@boardsesh/graphql/errors';
import type {
  BoardSetupInput,
  BoardSetupReviewReason,
  DirectoryReportSubmitResult,
  Gym,
  UserBoard,
} from '@boardsesh/shared-schema';
import type { RadioOption } from '../RadioGroup';
import { RadioGroup } from '../RadioGroup';
import { Button } from '../Button';
import { Text } from '../Text';
import { TextAction } from '../TextAction';
import { TickNoteField } from '../tick';
import { ReportProblemSheet } from './ReportProblemSheet';
import { SetupSuggestionFields } from './SetupSuggestionFields';
import { formatBoardSetupSummary, formatSetupSummary } from './setup-summary';
import {
  BOARD_REASONS,
  DUPLICATE_NOT_SURE,
  GYM_REASONS,
  boardReportAudience,
  canSendReport,
  canSendSetupReport,
  gymReportAudience,
  reportDoneCopy,
  setupDoneCopy,
  setupSuggestionLine,
  showClaimNudge,
} from './report-problem-model';
import { fetchBoardByUuid, useGym, useGymBoards } from '../../lib/graphql/hooks';
import { useReportBoard, useReportGym } from '../../lib/graphql/hooks/use-directory-reports';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useActivateBoard } from '../../lib/boards/use-activate-board';
import { boardKeepingLocalAngle, useApplyChangedBoard } from '../../lib/boards/use-apply-changed-board';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { useViewerUserId } from '../../hooks/use-viewer-user-id';
import { track } from '../../lib/analytics';
import { useDirectorySetupSuggestionsEnabled } from '../../providers/feature-flags-provider';
import { dismissManagedSheetAndWait, type ManagedSheetHandle } from '../../providers/sheet-presentation-provider';
import { spacing } from '../../theme/tokens';

/** What a report is about. A gym page passes the gym; every board surface the board. */
export type ReportProblemTarget = { kind: 'board'; board: UserBoard } | { kind: 'gym'; gym: Gym };

type TFn = ReturnType<typeof useTranslation>['t'];

function boardReasonLabel(reason: BoardReportReason, t: TFn): { label: string; description?: string } {
  switch (reason) {
    case 'wrong_setup':
      return { label: t('report.boardReasons.wrongSetup'), description: t('report.boardReasons.wrongSetupHint') };
    case 'duplicate':
      return { label: t('report.boardReasons.duplicate'), description: t('report.boardReasons.duplicateHint') };
    case 'gone':
      return { label: t('report.boardReasons.gone'), description: t('report.boardReasons.goneHint') };
    case 'wrong_place':
      return { label: t('report.boardReasons.wrongPlace'), description: t('report.boardReasons.wrongPlaceHint') };
    case 'other':
    case 'relist_request':
      return { label: t('report.boardReasons.other') };
  }
}

function gymReasonLabel(reason: GymReportReason, t: TFn): { label: string; description?: string } {
  switch (reason) {
    case 'duplicate':
      return { label: t('report.gymReasons.duplicate'), description: t('report.gymReasons.duplicateHint') };
    case 'closed':
      return { label: t('report.gymReasons.closed'), description: t('report.gymReasons.closedHint') };
    case 'wrong_details':
      return { label: t('report.gymReasons.details'), description: t('report.gymReasons.detailsHint') };
    case 'not_a_gym':
      return { label: t('report.gymReasons.home'), description: t('report.gymReasons.homeHint') };
    case 'other':
      return { label: t('report.gymReasons.other') };
  }
}

/**
 * The "who will see this" line. A switch with literal keys, not
 * `REPORT_AUDIENCE_COPY_KEYS[audience]`: the linter refuses `t(variable)`.
 */
export function reportAudienceLine(audience: ReportAudience, params: { name: string; gym: string }, t: TFn): string {
  switch (audience) {
    case 'creator':
      return t('report.routeCreator', params);
    case 'creator_hidden':
      return t('report.routeCreatorHidden', params);
    case 'creator_and_staff':
      return t('report.routeCreatorAndStaff', params);
    case 'creator_hidden_and_staff':
      return t('report.routeCreatorHiddenAndStaff', params);
    case 'creator_and_team':
      return t('report.routeCreatorAndTeam', params);
    case 'creator_hidden_and_team':
      return t('report.routeCreatorHiddenAndTeam', params);
    case 'creator_staff_and_team':
      return t('report.routeCreatorStaffAndTeam', params);
    case 'creator_hidden_staff_and_team':
      return t('report.routeCreatorHiddenStaffAndTeam', params);
    case 'staff':
      return t('report.routeStaff', params);
    case 'staff_and_team':
      return t('report.routeGymAndStaff', params);
    case 'team_unclaimed_gym':
      return t('report.routeTeam', params);
    case 'team':
      return t('report.routeGym', params);
  }
}

/** The line under Send for a changed setup. Literal keys: the linter refuses `t(variable)`. */
function setupPreviewLine(preview: SetupSuggestionPreview, gym: string, t: TFn): string {
  switch (preview) {
    case 'applies_for_everyone':
      return t('mobile.setupSuggestion.previewEveryone', { gym });
    case 'staff_review':
      return t('mobile.setupSuggestion.previewStaff', { gym });
    case 'creator_review':
      return t('mobile.setupSuggestion.previewCreator');
  }
}

/** The done line for a suggestion that went to review, by why it did. */
export function setupReviewLine(reason: BoardSetupReviewReason, gym: string, t: TFn): string {
  switch (reason) {
    case 'CLAIMED_GYM':
      return gym
        ? t('mobile.setupSuggestion.reviewClaimedGym', { gym })
        : t('mobile.setupSuggestion.reviewClaimedGymGeneric');
    case 'NO_GYM':
      return t('mobile.setupSuggestion.reviewNoGym');
    case 'RECENT_CHANGE':
      return t('mobile.setupSuggestion.reviewRecentChange', { hours: SETUP_CHANGE_BOARD_COOLDOWN_HOURS });
    case 'RECENTLY_UNDONE':
      return t('mobile.setupSuggestion.reviewRecentlyUndone', { days: SETUP_CHANGE_REVIEW_DAYS_AFTER_UNDO });
    case 'DAILY_LIMIT':
      return t('mobile.setupSuggestion.reviewDailyLimit', { count: SETUP_CHANGES_PER_CLIMBER_PER_DAY });
    case 'CLASHES':
      return t('mobile.setupSuggestion.reviewClashes');
  }
}

/** A setup the sheet can open on instead of the board's own: the climber's, from the builder. */
export type ReportInitialSetup = { layoutId: number; sizeId: number; setIds: string };

/** A selection as a comparable key: layout, size, sets in canonical order, and a fixed angle. */
function selectionKey(selection: SetupSelection | null): string {
  if (!selection) return '';
  const angle = selection.angleIsFixed ? String(selection.angle) : '';
  return `${selection.layoutId ?? ''}|${selection.sizeId ?? ''}|${normaliseSetIds(selection.setIds.join(','))}|${angle}`;
}

/** The setup reducer over a board this build may not know (no selection, no fields). */
function setupReducer(selection: SetupSelection | null, action: SetupSelectionAction): SetupSelection | null {
  return selection ? setupSelectionReducer(selection, action) : selection;
}

function initialSelectionFor({
  board,
  initialSetup,
}: {
  board: UserBoard | null;
  initialSetup: ReportInitialSetup | null;
}): SetupSelection | null {
  if (!board) return null;
  // The climber's setup on the board's own type and tilt: the angle stays the
  // board's, since an adjustable board's angle isn't part of what's wrong.
  return initialSetupSelection(initialSetup ? { ...board, ...initialSetup } : board);
}

type ReportReason = BoardReportReason | GymReportReason;

/**
 * The board as the server now has it, for the done step's "Climb it now".
 * `loading` while it is read again: the change committed but the answer
 * carried no board, or the server said the board already had the setup.
 * `failed` hides "Climb it now"; the done line stays.
 */
type DoneBoard = { status: 'loading' } | { status: 'ready'; board: UserBoard } | { status: 'failed' };

export function ReportDirectorySheet({
  target,
  onClose,
  onClaim,
  initialReason = null,
  initialSetup = null,
  climbNowOffered = true,
  closeAfterDismissed = false,
}: {
  target: ReportProblemTarget;
  onClose: () => void;
  /**
   * "Run {{gym}}? Claim it": called once this sheet has fully dismissed, so the
   * host can present the claim sheet without overlapping the two.
   */
  onClaim: (gym: Gym) => void;
  /** The reason to open on, already picked. */
  initialReason?: ReportReason | null;
  /**
   * The setup the climber says the board has, for "Set up wrong" on a board:
   * the setup fields open on it, or, with them off, the note says it.
   */
  initialSetup?: ReportInitialSetup | null;
  /**
   * The done step's "Climb it now". Off when the board is already bound and
   * the host moves on once this sheet closes (the builder's near-miss fix).
   */
  climbNowOffered?: boolean;
  /**
   * Call `onClose` only once this sheet has fully slid away, for a host that
   * navigates as soon as the report is done with (the builder's near-miss fix):
   * leaving while a native sheet is still dismissing is the overlap the
   * presentation coordinator exists to prevent.
   */
  closeAfterDismissed?: boolean;
}) {
  const { t } = useTranslation('boards');
  const { effectiveOffline } = useConnectivity();
  const viewerUserId = useViewerUserId();
  const board = target.kind === 'board' ? target.board : null;
  const boardGymUuid = board?.gymUuid ?? null;
  // A board report words its foot from its gym's listing state, which the board
  // doesn't carry. A gym report already has its gym.
  const { data: fetchedGym } = useGym(board ? boardGymUuid : null);
  const gym: Gym | null = target.kind === 'gym' ? target.gym : (fetchedGym ?? null);

  const [reason, setReason] = useState<ReportReason | null>(initialReason);
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);
  const [result, setResult] = useState<DirectoryReportSubmitResult | null>(null);
  const inFlight = useRef(false);
  // What the done step offers to climb, and what it was sent as, to word the
  // done line before the board arrives (or when it never does).
  const [doneBoard, setDoneBoard] = useState<DoneBoard | null>(null);
  const [sentSetup, setSentSetup] = useState<BoardSetupInput | null>(null);
  // The server refused the suggestion because the board already has it.
  const [alreadySetUp, setAlreadySetUp] = useState(false);

  // The setup fields start on the board as it is now. Null for a gym report,
  // and for a board type this build doesn't know, which keeps the note field.
  const setupSuggestionsEnabled = useDirectorySetupSuggestionsEnabled();
  const [selection, dispatchSetup] = useReducer(
    setupReducer,
    { board, initialSetup: board && initialReason === 'wrong_setup' ? initialSetup : null },
    initialSelectionFor,
  );
  const showSetupFields =
    setupSuggestionsEnabled &&
    board !== null &&
    selection !== null &&
    reason !== null &&
    isSetupSuggestionAllowed(reason, board.boardType);
  // With the setup fields off (the flag, or a board they don't cover), the
  // climber's setup goes into the note instead, for them to send or edit.
  const [generatedNote] = useState(() => {
    if (!board || !initialSetup || initialReason !== 'wrong_setup' || showSetupFields) return '';
    const setup = formatSetupSummary(board.boardType, initialSetup);
    return setup ? t('report.setupNote', { setup }).slice(0, REPORT_NOTE_MAX_LENGTH) : '';
  });
  const [note, setNote] = useState(generatedNote);
  // That note says the setup in words only while nothing better says it: the
  // setup fields appearing (the flag resolving late) or another reason take it
  // away, unless the climber has made it their own.
  useEffect(() => {
    if (!generatedNote) return;
    if (showSetupFields || reason !== 'wrong_setup') {
      setNote((current) => (current === generatedNote ? '' : current));
    }
  }, [generatedNote, showSetupFields, reason]);
  // What the sheet opened on, so a report nobody has touched yet closes
  // without asking to discard it.
  const [initialSelectionKey] = useState(() => selectionKey(selection));
  // Changed, and whole: a layout the catalogue lists no sets for can't be sent.
  const setupChanged =
    showSetupFields &&
    board !== null &&
    selection !== null &&
    isSetupSelectionComplete(selection) &&
    isSetupChanged(selection, board);

  // Two native sheets can't overlap a present with a dismiss (the coordinator
  // rule in docs/mobile/mobile-sheets-vs-routes.md): this sheet goes and
  // settles first, then the host presents the claim. Same handoff as the
  // review sheet's board actions.
  const sheetRef = useRef<ManagedSheetHandle>(null);
  const claiming = useRef(false);
  const claim = useCallback(
    async (claimTarget: Gym) => {
      if (claiming.current) return;
      claiming.current = true;
      const dismissal = await dismissManagedSheetAndWait(sheetRef.current);
      // The host went away mid-handoff: nothing left to present the claim from.
      // Still say the report is done, so a host waiting on it never hangs.
      if (dismissal.status === 'aborted') {
        onClose();
        return;
      }
      onClaim(claimTarget);
    },
    [onClaim, onClose],
  );

  // Done, Cancel, a pan-down or being displaced. A host that leaves the route
  // on close waits for the sheet to be gone first.
  const closing = useRef(false);
  const close = useCallback(() => {
    if (!closeAfterDismissed) {
      onClose();
      return;
    }
    if (closing.current) return;
    closing.current = true;
    void dismissManagedSheetAndWait(sheetRef.current).then(() => onClose());
  }, [closeAfterDismissed, onClose]);

  const reportBoard = useReportBoard();
  const reportGym = useReportGym();
  const mutation = target.kind === 'board' ? reportBoard : reportGym;
  const pending = mutation.isPending;

  // "Climb it now": this sheet goes and settles first, then the board is bound,
  // landing on Climbs like every other pick. Its reads already took the new
  // setup when it arrived (`settleBoard`), so the bind is the only write. On
  // the board already in use, the angle the climber set on the wall stays
  // (`boardKeepingLocalAngle`). The climber picked this board from a report,
  // not from the box the In range slot may be holding, so the bind names none.
  const applyChangedBoard = useApplyChangedBoard();
  const activateBoard = useActivateBoard({ returnTo: '/(tabs)/climbs', recognizesHeldBox: false });
  const { data: activeBoard } = useActiveBoard();
  const activeBoardRef = useRef(activeBoard ?? null);
  activeBoardRef.current = activeBoard ?? null;
  const climbing = useRef(false);
  const gymListingState = gym?.listingState ?? null;
  const climbNow = useCallback(
    async (boardToClimb: UserBoard) => {
      if (climbing.current) return;
      climbing.current = true;
      track(SHARED_EVENTS.BoardSetupClimbedNow, { boardType: boardToClimb.boardType, gymListingState });
      await dismissManagedSheetAndWait(sheetRef.current);
      onClose();
      await activateBoard(boardKeepingLocalAngle(boardToClimb, activeBoardRef.current));
    },
    [gymListingState, onClose, activateBoard],
  );

  // Everyone at the gym climbs the board as it now is, this climber included:
  // the board's reads, and the active board when it is this one, take it
  // before "Climb it now" is even tapped.
  const settleBoard = useCallback(
    (settled: UserBoard) => {
      setDoneBoard({ status: 'ready', board: settled });
      applyChangedBoard(settled).catch(() => {
        // The self-heal re-reads the active board on the next foreground.
      });
    },
    [applyChangedBoard],
  );
  // The board changed (or already had the setup) but the answer didn't carry
  // it: read it again. Until it arrives "Climb it now" waits; if it can't be
  // read the done line stays and "Climb it now" goes.
  const rereadBoard = useCallback(
    async (boardUuid: string) => {
      setDoneBoard({ status: 'loading' });
      try {
        const fresh = await fetchBoardByUuid(boardUuid);
        if (fresh) settleBoard(fresh);
        else setDoneBoard({ status: 'failed' });
      } catch {
        setDoneBoard({ status: 'failed' });
      }
    },
    [settleBoard],
  );

  // The other boards at this gym, for "Which board is the same wall?". Only
  // asked for once "Listed twice" is picked.
  const { data: gymBoards } = useGymBoards(board && reason === 'duplicate' ? boardGymUuid : null);
  const otherBoards = useMemo(
    () => (board ? (gymBoards ?? []).filter((candidate) => candidate.uuid !== board.uuid) : []),
    [gymBoards, board],
  );

  const reasonOptions = useMemo<RadioOption<ReportReason>[]>(
    () =>
      target.kind === 'board'
        ? BOARD_REASONS.map((value) => ({ value, ...boardReasonLabel(value, t), disabled: pending }))
        : GYM_REASONS.map((value) => ({ value, ...gymReasonLabel(value, t), disabled: pending })),
    [target.kind, t, pending],
  );
  const duplicateOptions = useMemo<RadioOption<string>[]>(
    () => [
      ...otherBoards.map((candidate) => ({ value: candidate.uuid, label: candidate.name })),
      { value: DUPLICATE_NOT_SURE, label: t('report.notSure') },
    ],
    [otherBoards, t],
  );

  const pickReason = useCallback(
    (next: ReportReason) => {
      if (!pending) setReason(next);
    },
    [pending],
  );
  const changeNote = useCallback((next: string) => setNote(next.slice(0, REPORT_NOTE_MAX_LENGTH)), []);
  const changeSetup = useCallback(
    (action: SetupSelectionAction) => {
      if (!pending) dispatchSetup(action);
    },
    [pending],
  );
  const pickDuplicate = useCallback(
    (next: string) => {
      if (!pending) setDuplicateOf(next);
    },
    [pending],
  );

  // With the setup fields up, a changed setup is enough to send, and a note
  // stands in for one only when it says enough. Otherwise today's note rule.
  const noteAllowsSend = showSetupFields ? canSendSetupReport({ setupChanged, note }) : canSendReport(reason, note);
  const canSend = noteAllowsSend && !effectiveOffline;
  const send = useCallback(() => {
    if (!reason || !noteAllowsSend || effectiveOffline || inFlight.current || result || alreadySetUp) return;
    inFlight.current = true;
    const suggestedSetup: BoardSetupInput | null = setupChanged && selection ? toSuggestedSetup(selection) : null;
    setSentSetup(suggestedSetup);
    const onSuccess = (submitted: DirectoryReportSubmitResult) => {
      setResult(submitted);
      track(SHARED_EVENTS.ReportProblemSent, {
        targetKind: target.kind,
        reason,
        status: submitted.status,
        platform: Platform.OS,
        hadSuggestion: suggestedSetup !== null,
        setupOutcome: submitted.setupOutcome ?? null,
      });
      if (submitted.setupOutcome === 'APPLIED' && target.kind === 'board') {
        // `board` is null when the change committed but the server couldn't
        // read the board back: the change stands, so read it by uuid.
        if (submitted.board) settleBoard(submitted.board);
        else void rereadBoard(target.board.uuid);
      }
    };
    // Someone fixed the board while this sheet was open: nothing to change,
    // and the board as it is now is the setup to climb.
    const onError = (error: unknown) => {
      if (target.kind === 'board' && suggestedSetup && isBoardSetupUnchangedError(error)) {
        setAlreadySetUp(true);
        void rereadBoard(target.board.uuid);
      }
    };
    const onSettled = () => {
      inFlight.current = false;
    };
    const normalizedNote = normalizeReportNote(note);
    if (target.kind === 'board') {
      reportBoard.mutate(
        {
          boardUuid: target.board.uuid,
          reason: reason as BoardReportReason,
          duplicateOfBoardUuid:
            reason === 'duplicate' && duplicateOf && duplicateOf !== DUPLICATE_NOT_SURE ? duplicateOf : null,
          note: normalizedNote,
          ...(suggestedSetup ? { suggestedSetup } : {}),
        },
        { onSuccess, onError, onSettled },
      );
    } else {
      reportGym.mutate(
        { gymUuid: target.gym.uuid, reason: reason as GymReportReason, note: normalizedNote },
        { onSuccess, onSettled },
      );
    }
  }, [
    reason,
    note,
    noteAllowsSend,
    effectiveOffline,
    result,
    alreadySetUp,
    target,
    duplicateOf,
    setupChanged,
    selection,
    reportBoard,
    reportGym,
    settleBoard,
    rereadBoard,
  ]);

  const gymName = gym?.name ?? board?.gymName ?? '';
  const subject =
    target.kind === 'gym'
      ? target.gym.name
      : board && gymName
        ? t('report.boardAtGym', { board: board.name, gym: gymName })
        : (board?.name ?? null);

  const audience: ReportAudience | null = board
    ? boardReportAudience({
        board,
        reason: (reason as BoardReportReason | null) ?? null,
        viewerUserId,
        gymListingState: gym?.listingState ?? null,
      })
    : gym
      ? gymReportAudience((reason as GymReportReason | null) ?? null, gym.listingState)
      : null;
  // A changed setup says what will happen to it instead of who will see it,
  // and says nothing while the board's gym is unknown (still loading, or its
  // read failed): the routing line would name the wrong reader.
  const setupPreview = setupChanged ? setupSuggestionLine({ boardGymUuid, gymListingState }) : null;
  const audienceLine = setupChanged
    ? setupPreview
      ? setupPreviewLine(setupPreview, gymName, t)
      : null
    : audience
      ? reportAudienceLine(audience, { name: board?.ownerDisplayName ?? '', gym: gymName }, t)
      : null;

  // "Climb it now" once the board is in hand; a spinner while it is read again;
  // nothing when it couldn't be read.
  const readyBoard = doneBoard?.status === 'ready' ? doneBoard.board : null;
  const climbNowAction =
    doneBoard && doneBoard.status !== 'failed' ? (
      <Button
        title={t('mobile.setupSuggestion.climbNow')}
        variant="filled"
        loading={readyBoard === null}
        disabled={readyBoard === null}
        onPress={() => {
          if (readyBoard) void climbNow(readyBoard);
        }}
        testID="report-problem-climb-now"
      />
    ) : null;

  let doneMessage: string | null = null;
  let doneTitle: string | null = null;
  let doneAction: ReactNode = null;
  if (alreadySetUp) {
    doneMessage = t('mobile.setupSuggestion.alreadySetUp');
    doneAction = climbNowOffered ? climbNowAction : null;
  } else if (result) {
    const setupDone = setupDoneCopy(result);
    if (setupDone?.kind === 'applied') {
      // The board's own setup once it is here; what was sent until then.
      const setup =
        (readyBoard
          ? formatBoardSetupSummary(readyBoard)
          : board && sentSetup
            ? formatSetupSummary(board.boardType, sentSetup)
            : null) ??
        readyBoard?.name ??
        board?.name ??
        '';
      const appliedGym = readyBoard?.gymName ?? gymName;
      doneTitle = t('mobile.setupSuggestion.appliedTitle');
      doneMessage = appliedGym
        ? t('mobile.setupSuggestion.appliedBody', { gym: appliedGym, setup })
        : t('mobile.setupSuggestion.appliedBodyGeneric', { setup });
      doneAction = climbNowOffered ? climbNowAction : null;
    } else if (setupDone?.kind === 'review') {
      doneMessage = setupReviewLine(setupDone.reason, gymName, t);
    } else {
      const done = reportDoneCopy(result);
      doneMessage =
        done.kind === 'already_reported'
          ? t('report.alreadyReported')
          : done.kind === 'joined'
            ? t('report.joined', { count: done.count })
            : t('report.sent');
    }
  }

  const noteRequired = reason === 'other';
  const trimmedLength = note.trim().length;
  const remaining = noteRequired ? Math.max(0, OTHER_REASON_NOTE_MIN_LENGTH - trimmedLength) : 0;
  let detail: ReactNode = null;
  if (reason !== null) {
    detail = (
      <View style={styles.detail}>
        {showSetupFields && selection ? (
          <>
            <SetupSuggestionFields selection={selection} onAction={changeSetup} disabled={pending} />
            {setupChanged ? null : (
              <Text variant="footnote" tone="secondary" testID="report-problem-setup-hint">
                {t('mobile.setupSuggestion.unchangedHint')}
              </Text>
            )}
          </>
        ) : null}
        {reason === 'duplicate' && board && otherBoards.length > 0 ? (
          <View style={styles.detail}>
            <Text variant="subheadline" tone="secondary">
              {t('report.duplicateBoardPick')}
            </Text>
            <View
              pointerEvents={pending ? 'none' : 'auto'}
              accessibilityState={{ disabled: pending }}
              style={pending ? styles.locked : undefined}
            >
              <RadioGroup options={duplicateOptions} value={duplicateOf} onChange={pickDuplicate} />
            </View>
          </View>
        ) : null}
        <TickNoteField
          submitBehavior="newline"
          value={note}
          onChangeText={changeNote}
          placeholder={
            noteRequired
              ? t('report.noteRequiredPlaceholder')
              : reason === 'wrong_setup' && !showSetupFields
                ? t('report.notePlaceholder')
                : t('report.noteLabel')
          }
          accessibilityLabel={noteRequired ? t('report.noteRequiredLabel') : t('report.noteLabel')}
        />
        {remaining > 0 ? (
          <Text variant="footnote" tone="secondary">
            {t('report.noteRemaining', { count: remaining })}
          </Text>
        ) : null}
      </View>
    );
  }

  const footer =
    audienceLine || showClaimNudge(gym) ? (
      <View style={styles.footer}>
        {audienceLine ? (
          <Text variant="footnote" tone="secondary" testID="report-problem-audience">
            {audienceLine}
          </Text>
        ) : null}
        {gym && showClaimNudge(gym) ? (
          <TextAction
            label={t('report.claimNudge', { gym: gym.name })}
            onPress={() => void claim(gym)}
            reach="up"
            testID="report-problem-claim"
          />
        ) : null}
      </View>
    ) : null;

  return (
    <ReportProblemSheet
      title={t('report.title')}
      subject={subject}
      question={t('report.question')}
      reasons={reasonOptions}
      reason={reason}
      onReasonChange={pickReason}
      detail={detail}
      footer={footer}
      sendLabel={t('report.send')}
      canSend={canSend}
      pending={pending}
      onSend={send}
      doneMessage={doneMessage}
      doneTitle={doneTitle}
      doneAction={doneAction}
      offlineMessage={effectiveOffline ? t('report.offline') : null}
      errorMessage={mutation.isError && !alreadySetUp ? t('report.error') : null}
      dirty={
        reason !== initialReason ||
        (note.length > 0 && note !== generatedNote) ||
        (setupChanged && selectionKey(selection) !== initialSelectionKey)
      }
      onClose={close}
      sheetRef={sheetRef}
      testID="report-problem"
    />
  );
}

const styles = StyleSheet.create({
  detail: { gap: spacing[2] },
  footer: { gap: spacing[2], alignItems: 'flex-start' },
  locked: { opacity: 0.5 },
});
