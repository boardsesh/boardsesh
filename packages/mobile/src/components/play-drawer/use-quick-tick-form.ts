// The create-tick form's state and derivations.
//
// Lifted out of QuickTickBar so the two halves of the sheet can live in
// different slots: the field stack renders in ModalSheet's scroll body, the
// Attempt/Send pair in its pinned footer. Both read the same form object, so
// there is still exactly one source of truth for what gets saved. The save
// itself goes through useTickSaver, the one path every mobile tick takes.
//
// Every returned callback has a stable identity — the row subtrees are
// React.memo'd, and a keystroke in the note must not re-render the grade and
// tries rails.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createInitialTickState, deriveAscentType, type QuickTickState, type TickStatus } from '@boardsesh/play-view';
import type { TickClimbIdentity } from '@boardsesh/board-config';
import { clampToNow, MAXIMUM_CLIMBED_AT_REFRESH_MS } from '../logbook/climbed-at';
import { useGrades } from '../../lib/graphql/hooks';
import { useToast } from '../../providers/toast-provider';
import { getDifficultyIdForGradeName } from '../../lib/grade-label';
import { isFirstAscentTick, useHasPriorTickHistory, useTickSaver, type TickSaver } from './use-tick-saver';

// Read once at module load rather than allocating a fresh createInitialTickState()
// on every field-snapshot sync (see below) just to read this one default.
const DEFAULT_ATTEMPT_COUNT = createInitialTickState().attemptCount;

// Field-completeness snapshot for the "abandoned the form" analytics event.
// Owned here (only place with the tick-state fields) but read by LogAscentSheet,
// which is the only place able to see the close-button and pan-down dismiss
// paths that never call onDismiss themselves.
export type QuickTickDismissSnapshot = {
  hasQuality: boolean;
  hasDifficulty: boolean;
  hasComment: boolean;
  attemptCountChanged: boolean;
};

export type QuickTickFormInput = {
  visible?: boolean;
  climb?: TickClimbIdentity;
  climbUuid: string;
  boardName: string;
  /** The angle the sheet opened at — the board's current angle. The climber can
   *  change it in the form; this stays the opening value. */
  angle: number;
  isMirror: boolean;
  isBenchmark: boolean;
  /** Immutable community send count captured with the climb that opened this form. */
  baseAscensionistCount: number;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  sessionId?: string | null;
  // The climb's consensus grade label (e.g. "V5", "7a+"). Resolved to a numeric
  // difficulty id here via the loaded grades list so the consensus chip can be
  // outlined without being preselected.
  consensusGradeName?: string;
  onDismiss: () => void;
  // Optional analytics plumbing for LogAscentSheet's dismiss tracking. Both are
  // refs (not state) so updating them never triggers a re-render.
  savedRef?: React.RefObject<boolean>;
  fieldSnapshotRef?: React.RefObject<QuickTickDismissSnapshot>;
};

export type QuickTickForm = {
  privacy?: TickSaver['privacy'];
  /** The climb this form is bound to. Surfaced so presentational children can
   *  tell "a new climb loaded" from "the climber changed a field" — the hosting
   *  sheet stays mounted across climbs, so no value change is a reliable signal. */
  climbUuid: string;
  /** The climb's board, so the grade rail labels follow its scale. */
  boardName?: string;
  /** The angle the tick is logged at. Starts at the opening angle (the board's)
   *  and follows the angle row; this is what gets saved (#6615). */
  angle: number;
  /** The angle the sheet opened at. The climb's consensus grade and send count
   *  belong to this angle, not to `angle` once the climber moves off it. */
  openingAngle: number;
  tickState: QuickTickState;
  comment: string;
  climbedAt: Date;
  maximumClimbedAtDate: Date;
  grades: ReturnType<typeof useGrades>['data'];
  consensusDifficultyId: number | undefined;
  /**
   * The climber is logging the first ascent of a spray climb (#5971): nobody has
   * sent it, and their grade becomes the climb's grade. The sheet says so, offers
   * no default grade, and a flash or send needs one.
   */
  firstAscent: boolean;
  /** True while a first-ascent flash or send is still missing its grade. */
  saveBlockedByGrade: boolean;
  /** The picked difficulty id resolved back to its grade name, for the header's
   *  identity bar and for analytics. */
  resolvedGradeName: string | undefined;
  ascentType: TickStatus;
  /** Label of the primary action: Flash or Send, following the derived type. */
  saveLabel: string;
  isPending: boolean;
  lastError: string | null;
  onQualitySelect: (value: number | null) => void;
  onAngleSelect: (angle: number) => void;
  onGradeSelect: (difficultyId: number | undefined) => void;
  onTriesSelect: (value: number) => void;
  onCommentChange: (next: string) => void;
  onClimbedAtChange: (next: Date) => void;
  onFutureAdjusted: () => void;
  onSave: () => void;
  onAttempt: () => void;
};

export function useQuickTickForm({
  visible = true,
  climb,
  climbUuid,
  boardName,
  angle,
  isMirror,
  isBenchmark,
  baseAscensionistCount,
  layoutId,
  sizeId,
  setIds,
  sessionId,
  consensusGradeName,
  onDismiss,
  savedRef,
  fieldSnapshotRef,
}: QuickTickFormInput): QuickTickForm {
  const { t } = useTranslation('session');
  const { t: tClimbs } = useTranslation('climbs');
  const { showToast } = useToast();
  const tickSaver = useTickSaver({
    climb,
    climbUuid,
    boardName,
    layoutId,
    sizeId,
    setIds,
    sessionId,
    active: visible,
    surface: 'mobile_quick_tick',
  });
  const { save: saveTick, tickBoardName } = tickSaver;
  const { data: grades } = useGrades(tickBoardName);

  // The angle the climber picked in the angle row. It lives as long as the
  // other fields do: cleared with them on a new climb and after a save, kept
  // across an accidental pan-down and reopen, so a reopened sheet never keeps
  // the stars but quietly drops the angle. Tagged with the opening angle it was
  // picked against, so a board moved to another angle meanwhile reads the new
  // angle instead of a pick made for the old one.
  const [pickedAngle, setPickedAngle] = useState<{ openingAngle: number; angle: number } | null>(null);
  const selectedAngle = pickedAngle && pickedAngle.openingAngle === angle ? pickedAngle.angle : angle;
  // The climb's stats came with the opening angle. Another angle is, as far as
  // this sheet knows, a different problem: its consensus grade and its senders
  // are unknown here.
  const atOpeningAngle = selectedAngle === angle;

  const hasPriorHistory = useHasPriorTickHistory(climbUuid, tickBoardName, selectedAngle);

  const [tickState, setTickState] = useState(createInitialTickState);
  const [comment, setComment] = useState('');
  // The climb date/time to log. Defaults to now; the Date/Time fields let the
  // user backdate a send they forgot to log (issue #3303).
  const [climbedAt, setClimbedAt] = useState(() => new Date());
  const [maximumClimbedAtDate, setMaximumClimbedAtDate] = useState(() => new Date());
  // Whether the user explicitly picked a date/time. Until they do, the tick logs
  // at *save-time* now — this sheet stays mounted (PlayDrawer only toggles
  // visibility), so a value frozen at mount would otherwise save a stale
  // timestamp minutes/hours in the past.
  const hasEditedClimbedAtRef = useRef(false);
  // Rendered in the action bar's reserved error slot when the last save attempt
  // failed. Cleared on the next attempt or on success.
  const [lastError, setLastError] = useState<string | null>(null);

  // The first ascent of a spray climb (#5971). `baseAscensionistCount` is the
  // count the sheet opened with, so it says nothing about any other angle.
  const firstAscent = isFirstAscentTick(boardName, baseAscensionistCount) && atOpeningAngle;
  // Resolve the consensus grade *name* (e.g. "V5") to a numeric difficulty
  // id by matching against the loaded grades list. The id is what
  // GradeSingleSelectRail compares against each chip's `difficultyId`.
  const consensusDifficultyId = useMemo(() => {
    // No outline on a first ascent: whatever grade the climb carries is not a
    // consensus yet, and the climber's grade should be their own. None at another
    // angle either: the consensus is per angle, and outlining 40°'s grade on a
    // 45° tick would steer the climber to the wrong one.
    if (firstAscent || !atOpeningAngle || !consensusGradeName || !grades) return undefined;
    // Fall back to the id behind the name: a label from another source can
    // spell the same grade differently (MoonBoard's 16 was "6a/V3" before it
    // became "6a/V2").
    const consensusId = getDifficultyIdForGradeName(consensusGradeName);
    return grades.find((grade) => grade.name === consensusGradeName || grade.difficultyId === consensusId)
      ?.difficultyId;
  }, [firstAscent, atOpeningAngle, consensusGradeName, grades]);

  // Inverse of consensusDifficultyId: resolve the picked numeric difficulty
  // id back to its human-readable grade name (e.g. "V5") for analytics.
  const resolvedGradeName = useMemo(() => {
    if (tickState.difficulty == null || !grades) return undefined;
    return grades.find((grade) => grade.difficultyId === tickState.difficulty)?.name;
  }, [tickState.difficulty, grades]);

  // Type follows the count, never the reverse — the picker floors at MIN_ATTEMPT_COUNT
  // for every status, so what it shows and what gets saved can't drift (#2888).
  const ascentType = deriveAscentType(hasPriorHistory, tickState.attemptCount);

  // Keep the dismiss-analytics snapshot current so LogAscentSheet can read
  // field-completeness at close time — its close-button/pan-down paths never
  // call back into the form, so they can't read tickState directly.
  useEffect(() => {
    if (!fieldSnapshotRef) return;
    fieldSnapshotRef.current = {
      hasQuality: tickState.quality != null && tickState.quality > 0,
      hasDifficulty: tickState.difficulty != null,
      hasComment: comment.length > 0,
      attemptCountChanged: tickState.attemptCount !== DEFAULT_ATTEMPT_COUNT,
    };
  }, [fieldSnapshotRef, tickState.quality, tickState.difficulty, tickState.attemptCount, comment]);

  // Reset form state when the climb context changes underneath an open
  // sheet (e.g. user swiped to next while the sheet was already open).
  useEffect(() => {
    setTickState(createInitialTickState());
    setPickedAngle(null);
    setComment('');
    setLastError(null);
    setClimbedAt(new Date());
    setMaximumClimbedAtDate(new Date());
    hasEditedClimbedAtRef.current = false;
  }, [climbUuid]);

  // Keep "now" fresh while the sheet lives on. The picker's upper bound tracks
  // now so a long-open sheet can't select a future minute; and, until the user
  // picks a date, the displayed default tracks now too so a reopened sheet
  // doesn't show a stale day. Mirrors LogbookEditSheet's max-date refresh.
  useEffect(() => {
    const intervalId = setInterval(() => {
      setMaximumClimbedAtDate(new Date());
      if (!hasEditedClimbedAtRef.current) setClimbedAt(new Date());
    }, MAXIMUM_CLIMBED_AT_REFRESH_MS);
    return () => clearInterval(intervalId);
  }, []);

  const handleQualitySelect = useCallback((value: number | null) => {
    setTickState((prev) => ({ ...prev, quality: value }));
  }, []);

  const handleAngleSelect = useCallback(
    (next: number) => setPickedAngle({ openingAngle: angle, angle: next }),
    [angle],
  );

  const handleClimbedAtChange = useCallback((next: Date) => {
    hasEditedClimbedAtRef.current = true;
    setClimbedAt(next);
  }, []);

  const handleFutureAdjusted = useCallback(() => {
    showToast(tClimbs('mobile.tick.futureTimeAdjusted'), 'warning');
  }, [showToast, tClimbs]);

  const handleGradeSelect = useCallback((difficultyId: number | undefined) => {
    setTickState((prev) => ({ ...prev, difficulty: difficultyId }));
  }, []);

  const handleTriesSelect = useCallback((value: number) => {
    setTickState((prev) => ({ ...prev, attemptCount: value }));
  }, []);

  const saveBlockedByGrade = firstAscent && tickState.difficulty == null;

  const handleSaveWithStatus = useCallback(
    (status: TickStatus) => {
      // A first-ascent flash or send sets the climb's grade, so it needs one. An
      // attempt sets nothing and goes through.
      if (status !== 'attempt' && saveBlockedByGrade) return;
      setLastError(null);

      // Hoisted out of the fields so the rest timer anchors on the exact instant
      // we send, rather than re-deriving one after onSaved has already reset
      // `hasEditedClimbedAtRef`.
      // Untouched: log a fresh save-time "now". Edited: honour the pick
      // (clamped, in case the sheet sat open past the chosen minute).
      const climbedAtIso = (hasEditedClimbedAtRef.current ? clampToNow(climbedAt) : new Date()).toISOString();

      saveTick(
        {
          status,
          attemptCount: tickState.attemptCount,
          angle: selectedAngle,
          isMirror,
          isBenchmark,
          quality: tickState.quality,
          difficulty: tickState.difficulty ?? null,
          comment,
          climbedAtIso,
          // The count the sheet opened with is the opening angle's senders. Sent
          // with a tick at another angle, it would floor THAT angle's optimistic
          // count at one above the opening angle's (37 senders at 40° shows 38 at
          // a 45° nobody has sent). Without it, the count waits for the server.
          baseAscensionistCount: atOpeningAngle ? baseAscensionistCount : undefined,
          gradeName: resolvedGradeName ?? null,
        },
        {
          onSaved: () => {
            // Reset on commit so reopening the sheet on the same climb
            // doesn't show stale state from the just-saved tick.
            setTickState(createInitialTickState());
            setPickedAngle(null);
            setComment('');
            setLastError(null);
            setClimbedAt(new Date());
            setMaximumClimbedAtDate(new Date());
            hasEditedClimbedAtRef.current = false;
            showToast(tClimbs('mobile.logAscent.savedToast'), 'success');
            // Tell LogAscentSheet this close is a completed save, not an
            // abandon, so its wrapped onClose doesn't fire QuickTickDismissed.
            if (savedRef) savedRef.current = true;
            onDismiss();
          },
          onFailed: setLastError,
        },
      );
    },
    [
      saveTick,
      saveBlockedByGrade,
      selectedAngle,
      isMirror,
      isBenchmark,
      baseAscensionistCount,
      atOpeningAngle,
      tickState,
      comment,
      climbedAt,
      onDismiss,
      showToast,
      tClimbs,
      resolvedGradeName,
      savedRef,
    ],
  );

  const handleSave = useCallback(() => handleSaveWithStatus(ascentType), [handleSaveWithStatus, ascentType]);
  const handleAttempt = useCallback(() => handleSaveWithStatus('attempt'), [handleSaveWithStatus]);

  const saveLabel = ascentType === 'flash' ? t('playView.tickBar.flashSaveLabel') : t('playView.tickBar.sendSaveLabel');

  return {
    climbUuid,
    boardName,
    angle: selectedAngle,
    openingAngle: angle,
    tickState,
    comment,
    climbedAt,
    maximumClimbedAtDate,
    grades,
    consensusDifficultyId,
    firstAscent,
    saveBlockedByGrade,
    resolvedGradeName,
    ascentType,
    saveLabel,
    isPending: tickSaver.isPending,
    lastError,
    onQualitySelect: handleQualitySelect,
    onAngleSelect: handleAngleSelect,
    onGradeSelect: handleGradeSelect,
    onTriesSelect: handleTriesSelect,
    onCommentChange: setComment,
    onClimbedAtChange: handleClimbedAtChange,
    onFutureAdjusted: handleFutureAdjusted,
    onSave: handleSave,
    privacy: tickSaver.privacy,
    onAttempt: handleAttempt,
  };
}
