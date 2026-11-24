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

import { useCallback, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  initialSetupSelection,
  isSetupChanged,
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
import { formatBoardSetupSummary } from './setup-summary';
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
import { useGym, useGymBoards } from '../../lib/graphql/hooks';
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

/** The setup reducer over a board this build may not know (no selection, no fields). */
function setupReducer(selection: SetupSelection | null, action: SetupSelectionAction): SetupSelection | null {
  return selection ? setupSelectionReducer(selection, action) : selection;
}

function initialSelectionFor(board: UserBoard | null): SetupSelection | null {
  return board ? initialSetupSelection(board) : null;
}

type ReportReason = BoardReportReason | GymReportReason;

export function ReportDirectorySheet({
  target,
  onClose,
  onClaim,
}: {
  target: ReportProblemTarget;
  onClose: () => void;
  /**
   * "Run {{gym}}? Claim it": called once this sheet has fully dismissed, so the
   * host can present the claim sheet without overlapping the two.
   */
  onClaim: (gym: Gym) => void;
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

  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);
  const [result, setResult] = useState<DirectoryReportSubmitResult | null>(null);
  const inFlight = useRef(false);

  // The setup fields start on the board as it is now. Null for a gym report,
  // and for a board type this build doesn't know, which keeps the note field.
  const setupSuggestionsEnabled = useDirectorySetupSuggestionsEnabled();
  const [selection, dispatchSetup] = useReducer(setupReducer, board, initialSelectionFor);
  const showSetupFields =
    setupSuggestionsEnabled &&
    board !== null &&
    selection !== null &&
    reason !== null &&
    isSetupSuggestionAllowed(reason, board.boardType);
  const setupChanged = showSetupFields && board !== null && selection !== null && isSetupChanged(selection, board);

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
      if (dismissal.status === 'aborted') return;
      onClaim(claimTarget);
    },
    [onClaim],
  );

  const reportBoard = useReportBoard();
  const reportGym = useReportGym();
  const mutation = target.kind === 'board' ? reportBoard : reportGym;
  const pending = mutation.isPending;

  // "Climb it now": this sheet goes and settles first, then the new setup is
  // written where the app reads it and the board is bound, landing on Climbs
  // like every other pick. On the board already in use, the angle the climber
  // set on the wall stays (`boardKeepingLocalAngle`).
  const applyChangedBoard = useApplyChangedBoard();
  const activateBoard = useActivateBoard({ returnTo: '/(tabs)/climbs' });
  const { data: activeBoard } = useActiveBoard();
  const activeBoardRef = useRef(activeBoard ?? null);
  activeBoardRef.current = activeBoard ?? null;
  const climbing = useRef(false);
  const gymListingState = gym?.listingState ?? null;
  const climbNow = useCallback(
    async (applied: UserBoard) => {
      if (climbing.current) return;
      climbing.current = true;
      track(SHARED_EVENTS.BoardSetupClimbedNow, { boardType: applied.boardType, gymListingState });
      await dismissManagedSheetAndWait(sheetRef.current);
      onClose();
      try {
        await applyChangedBoard(applied);
      } catch {
        // The bind below writes the active board again; the lists re-read anyway.
      }
      await activateBoard(boardKeepingLocalAngle(applied, activeBoardRef.current));
    },
    [gymListingState, onClose, applyChangedBoard, activateBoard],
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
    if (!reason || !noteAllowsSend || effectiveOffline || inFlight.current || result) return;
    inFlight.current = true;
    const suggestedSetup: BoardSetupInput | null = setupChanged && selection ? toSuggestedSetup(selection) : null;
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
      // Everyone at the gym climbs the new setup now, this climber included:
      // the board's reads, and the active board when it is this one, take it
      // before "Climb it now" is even tapped.
      if (submitted.setupOutcome === 'APPLIED' && submitted.board) {
        applyChangedBoard(submitted.board).catch(() => {
          // The self-heal re-reads the active board on the next foreground.
        });
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
        { onSuccess, onSettled },
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
    target,
    duplicateOf,
    setupChanged,
    selection,
    reportBoard,
    reportGym,
    applyChangedBoard,
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
  // A changed setup says what will happen to it instead of who will see it.
  const setupPreview = setupChanged ? setupSuggestionLine({ boardGymUuid, gymListingState }) : null;
  const audienceLine = setupPreview
    ? setupPreviewLine(setupPreview, gymName, t)
    : audience
      ? reportAudienceLine(audience, { name: board?.ownerDisplayName ?? '', gym: gymName }, t)
      : null;

  let doneMessage: string | null = null;
  let doneTitle: string | null = null;
  let doneAction: ReactNode = null;
  if (result) {
    const setupDone = setupDoneCopy(result);
    if (setupDone?.kind === 'applied') {
      const applied = setupDone.board;
      const setup = formatBoardSetupSummary(applied) ?? applied.name;
      const appliedGym = applied.gymName ?? gymName;
      doneTitle = t('mobile.setupSuggestion.appliedTitle');
      doneMessage = appliedGym
        ? t('mobile.setupSuggestion.appliedBody', { gym: appliedGym, setup })
        : t('mobile.setupSuggestion.appliedBodyGeneric', { setup });
      doneAction = (
        <Button
          title={t('mobile.setupSuggestion.climbNow')}
          variant="filled"
          onPress={() => void climbNow(applied)}
          testID="report-problem-climb-now"
        />
      );
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
      errorMessage={mutation.isError ? t('report.error') : null}
      dirty={reason !== null || note.length > 0 || setupChanged}
      onClose={onClose}
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
