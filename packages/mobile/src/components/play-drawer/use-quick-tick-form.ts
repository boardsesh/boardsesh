// The create-tick form's state, derivations and save path.
//
// Lifted out of QuickTickBar so the two halves of the sheet can live in
// different slots: the field stack renders in ModalSheet's scroll body, the
// Attempt/Send pair in its pinned footer. Both read the same form object, so
// there is still exactly one source of truth for what gets saved.
//
// Every returned callback has a stable identity — the row subtrees are
// React.memo'd, and a keystroke in the note must not re-render the grade and
// tries rails.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createInitialTickState,
  deriveAscentType,
  clampAttempts,
  type QuickTickState,
  type TickStatus,
} from '@boardsesh/play-view';
import {
  useOptionalBoardActions,
  useOptionalBoardLogbook,
  useSaveTick,
  logbookClimbAngleKey,
} from '@boardsesh/board-react';
import { toBoardName, normaliseSetIds } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { clampToNow, MAXIMUM_CLIMBED_AT_REFRESH_MS } from '../logbook/climbed-at';
import { useGrades } from '../../lib/graphql/hooks';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useToast } from '../../providers/toast-provider';
import { useOptionalRogueTimer } from '../../providers/rogue-timer-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useLocalPendingTicks } from '../../hooks/use-local-ticks';
import { useIsOffline } from '../../hooks/use-is-offline';
import { track } from '../../lib/analytics';
import { hapticSuccess, hapticError } from '../../lib/haptics';

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
  climbUuid: string;
  boardName: string;
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
  /** The climb this form is bound to. Surfaced so presentational children can
   *  tell "a new climb loaded" from "the climber changed a field" — the hosting
   *  sheet stays mounted across climbs, so no value change is a reliable signal. */
  climbUuid: string;
  tickState: QuickTickState;
  comment: string;
  climbedAt: Date;
  maximumClimbedAtDate: Date;
  grades: ReturnType<typeof useGrades>['data'];
  consensusDifficultyId: number | undefined;
  /** The picked difficulty id resolved back to its grade name, for the header's
   *  identity bar and for analytics. */
  resolvedGradeName: string | undefined;
  ascentType: TickStatus;
  /** Label of the primary action: Flash or Send, following the derived type. */
  saveLabel: string;
  isPending: boolean;
  lastError: string | null;
  onQualitySelect: (value: number | null) => void;
  onGradeSelect: (difficultyId: number | undefined) => void;
  onTriesSelect: (value: number) => void;
  onCommentChange: (next: string) => void;
  onClimbedAtChange: (next: Date) => void;
  onFutureAdjusted: () => void;
  onSave: () => void;
  onAttempt: () => void;
};

export function useQuickTickForm({
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
  const saveTick = useSaveTick(toBoardName(boardName));
  // Only the (stable, memoized) startStopwatch action is used here — depend on
  // it directly so the save handler isn't recreated on every timer status /
  // deviceName change.
  const startTimerStopwatch = useOptionalRogueTimer()?.startStopwatch;
  const { enabled: boardPresenceEnabled, boardId: boardPresenceBoardId } = useBoardPresenceControls();
  const { data: grades } = useGrades(boardName);

  // Mobile's `Climb.userAscents`/`userAttempts` GraphQL fields aren't
  // populated server-side, so we read the user's accumulated logbook
  // (denormalised via `BoardProvider` → `useLogbook`) directly. Same
  // logbook source the climb-row status glyph reads.
  //
  // Two failure modes the save-button label must guard against:
  // 1. `BoardProvider` not mounted → no logbook context at all → `Send`.
  // 2. Provider is mounted but this climb's ticks haven't been fetched
  //    yet → the lookup returns nothing. We trigger `getLogbook` on mount
  //    (idempotent thanks to useLogbook's fetched-uuid dedupe) so the
  //    answer becomes authoritative on the next render after the fetch
  //    resolves. In the brief window before then the label may still read
  //    `Flash` for a climb that actually has history — bounded to flows
  //    that bypass the climbs-index pre-fetch (e.g. deep link to
  //    /climbs/[uuid]).
  //
  // Read the prebuilt `logbookByClimbAngle` index (an O(1) Map lookup the
  // BoardProvider rebuilds once per logbook change) rather than scanning
  // the raw `logbook` array — otherwise every logbook merge while this
  // sheet is open (own tick saves, list paging, peer ticks in a session)
  // re-runs an O(logbook) scan. Same index `useAscentStatus` reads.
  const boardActions = useOptionalBoardActions();
  const boardLogbook = useOptionalBoardLogbook();
  const { data: localPendingTicks = 0 } = useLocalPendingTicks(climbUuid, boardName);

  // The board the climber selected, sent so the tick attaches to THAT wall
  // rather than to whatever the presence layer happens to be bound to. Every
  // serial-less wall (all of MoonBoard) binds presence to one system-owned feed
  // shared by that configuration globally, so without this the tick lands on
  // the shared feed and the climber's own board reads as empty on Home (#5121).
  //
  // Guarded on a config match because the drawer sends the RENDER board's
  // config for a climb that doesn't fit the selected wall, and the server drops
  // a boardUuid whose config disagrees without falling back to anything
  // (#4219) — sending it unguarded would leave those ticks with no board at all.
  const { data: activeBoard } = useActiveBoard();
  const selectedBoardUuid = useMemo(() => {
    if (!activeBoard || layoutId == null || sizeId == null || !setIds) return null;
    const isSelectedBoard =
      activeBoard.boardType === boardName &&
      activeBoard.layoutId === layoutId &&
      activeBoard.sizeId === sizeId &&
      normaliseSetIds(activeBoard.setIds) === normaliseSetIds(setIds);
    return isSelectedBoard ? activeBoard.uuid : null;
  }, [activeBoard, boardName, layoutId, sizeId, setIds]);
  // Read through a ref so the save handler's identity doesn't change on every
  // connectivity flip (the file's existing stable-identity idiom). A save that
  // fails while offline has already exhausted the local write, the retry ladder
  // and the outbox degrade — the network error's own message is a technical,
  // English-only string, so say what happened in the climber's language instead.
  // Online, the error's own message is worth reading and stays.
  const isOffline = useIsOffline();
  const isOfflineRef = useRef(isOffline);
  isOfflineRef.current = isOffline;
  useEffect(() => {
    if (!boardActions) return;
    void boardActions.getLogbook([climbUuid]);
  }, [boardActions, climbUuid]);
  const hasPriorHistory = useMemo(() => {
    // A locally-queued tick that hasn't drained yet still counts as history so
    // the label stays `Send` while offline.
    if (localPendingTicks > 0) return true;
    // No provider → assume history so the label stays `Send` (failure mode 1).
    if (!boardLogbook) return true;
    // Not fetched yet → also assume history (failure mode 2). An empty index
    // lookup can't distinguish "no ticks" from "not loaded", and guessing
    // "no ticks" offers a green Flash on a climb the user has sent many times;
    // tapping it in that window writes a phantom flash, which is worse than a
    // Send label that resolves to Flash a moment later (#3940).
    if (!boardLogbook.fetchedLogbookClimbUuids.has(climbUuid)) return true;
    return (boardLogbook.logbookByClimbAngle.get(logbookClimbAngleKey(climbUuid, angle))?.length ?? 0) > 0;
  }, [boardLogbook, climbUuid, angle, localPendingTicks]);

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

  // Resolve the consensus grade *name* (e.g. "V5") to a numeric difficulty
  // id by matching against the loaded grades list. The id is what
  // GradeSingleSelectRail compares against each chip's `difficultyId`.
  const consensusDifficultyId = useMemo(() => {
    if (!consensusGradeName || !grades) return undefined;
    return grades.find((grade) => grade.name === consensusGradeName)?.difficultyId;
  }, [consensusGradeName, grades]);

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

  const handleSaveWithStatus = useCallback(
    (status: TickStatus) => {
      if (saveTick.isPending) return;
      setLastError(null);

      // Mirrors the server's flash-is-one-try rule; a no-op for every value the picker can show.
      const finalAttempts = clampAttempts(tickState.attemptCount, status);

      saveTick.mutate(
        {
          climbUuid,
          angle,
          isMirror,
          status,
          attemptCount: finalAttempts,
          quality: tickState.quality != null && tickState.quality > 0 ? tickState.quality : null,
          difficulty: tickState.difficulty ?? null,
          isBenchmark,
          baseAscensionistCount,
          comment,
          // Untouched: log a fresh save-time "now". Edited: honour the pick
          // (clamped, in case the sheet sat open past the chosen minute).
          climbedAt: (hasEditedClimbedAtRef.current ? clampToNow(climbedAt) : new Date()).toISOString(),
          ...(sessionId ? { sessionId } : {}),
          ...(layoutId != null ? { layoutId } : {}),
          ...(sizeId != null ? { sizeId } : {}),
          ...(setIds ? { setIds } : {}),
          ...(selectedBoardUuid ? { boardUuid: selectedBoardUuid } : {}),
          ...(boardPresenceEnabled && boardPresenceBoardId != null ? { boardId: boardPresenceBoardId } : {}),
        },
        {
          onSuccess: () => {
            // One event per committed tick. This used to fire QuickTickSaved and
            // TickLogged back to back with the same climb/status, plus a
            // TickButtonClicked on the way in — four events per tick once
            // QuickTickOpened is counted. TickLogged is the canonical
            // cross-platform join event, so it absorbed QuickTickSaved's payload.
            track(SHARED_EVENTS.TickLogged, {
              climbUuid,
              layoutId: layoutId ?? null,
              status,
              platform: 'mobile',
              surface: 'mobile_quick_tick',
              attemptCount: finalAttempts,
              hasQuality: tickState.quality != null && tickState.quality > 0,
              hasDifficulty: tickState.difficulty != null,
              difficulty: tickState.difficulty ?? null,
              grade: resolvedGradeName ?? null,
              hasComment: comment.length > 0,
            });
            hapticSuccess();
            // Kick off the paired gym timer's stopwatch. No-op unless a Rogue
            // timer is connected — which only happens while this user is driving
            // the wall (see RogueTimerProvider), so a passenger's tick can't
            // touch the timer. Fire-and-forget; never block the save flow.
            void startTimerStopwatch?.();
            // Reset on commit so reopening the sheet on the same climb
            // doesn't show stale state from the just-saved tick.
            setTickState(createInitialTickState());
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
          onError: (error: unknown) => {
            hapticError();
            track(SHARED_EVENTS.QuickTickFailed, { climbUuid, layoutId: layoutId ?? null });
            const message = isOfflineRef.current
              ? tClimbs('mobile.logAscent.offlineErrorMessage')
              : error instanceof Error && error.message
                ? error.message
                : tClimbs('mobile.logAscent.errorMessage');
            setLastError(message);
          },
        },
      );
    },
    [
      saveTick,
      climbUuid,
      angle,
      isMirror,
      isBenchmark,
      baseAscensionistCount,
      sessionId,
      layoutId,
      sizeId,
      setIds,
      boardPresenceEnabled,
      boardPresenceBoardId,
      selectedBoardUuid,
      tickState,
      comment,
      climbedAt,
      onDismiss,
      showToast,
      tClimbs,
      resolvedGradeName,
      savedRef,
      startTimerStopwatch,
    ],
  );

  const handleSave = useCallback(() => handleSaveWithStatus(ascentType), [handleSaveWithStatus, ascentType]);
  const handleAttempt = useCallback(() => handleSaveWithStatus('attempt'), [handleSaveWithStatus]);

  const saveLabel = ascentType === 'flash' ? t('playView.tickBar.flashSaveLabel') : t('playView.tickBar.sendSaveLabel');

  return {
    climbUuid,
    tickState,
    comment,
    climbedAt,
    maximumClimbedAtDate,
    grades,
    consensusDifficultyId,
    resolvedGradeName,
    ascentType,
    saveLabel,
    isPending: saveTick.isPending,
    lastError,
    onQualitySelect: handleQualitySelect,
    onGradeSelect: handleGradeSelect,
    onTriesSelect: handleTriesSelect,
    onCommentChange: setComment,
    onClimbedAtChange: handleClimbedAtChange,
    onFutureAdjusted: handleFutureAdjusted,
    onSave: handleSave,
    onAttempt: handleAttempt,
  };
}
