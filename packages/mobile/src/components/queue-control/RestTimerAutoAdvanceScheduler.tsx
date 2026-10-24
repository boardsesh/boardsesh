// Fires the rest timer's auto-advance (#5378). Renders nothing and sets no state
// per tick: it owns ONE `setTimeout` for the exact remaining milliseconds, so a
// running timer costs the app tree nothing between beats.
//
// Everything here is a guard. The failure mode this component can produce is
// "the wall changed under a climber", so each rule below is paired with a test
// that asserts it does NOT fire.

import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import { computeNavigationStateWithSuggestions } from '@boardsesh/play-view';
import { isClimbOnReachableBoard, type PlaylistSuggestionSource } from '@boardsesh/queue';
import { useReachableBoardKeys } from '../../providers/queue/use-reachable-board-keys';
import { toBoardName } from '@boardsesh/board-config';
import { useQueueActions, useQueueData, usePlaylistSuggestionSource } from '../../providers/queue-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useToast } from '../../providers/toast-provider';
import { canLoadMoreOfTrack } from '../../lib/playlists/track-pager';
import { useTrackPaging } from '../play-drawer/use-track-paging';
import { useKeepAwakeWhile } from '../../hooks/use-keep-awake-while';
import { useEffectiveRestPacing } from '../../hooks/use-effective-rest-pacing';
import { useSessionTimerDriver } from '../../hooks/use-session-timer-driver';
import { useRestTimerState } from '../../hooks/use-rest-timer';
import { nowMs } from '../../lib/clock';
import { playRestTimerCue } from '../../lib/rest-timer-cues';
import {
  clearRestTimerQueueEnded,
  noteRestTimerAutoAdvanceFired,
  noteRestTimerQueueEnded,
  reanchorRestTimerAfterBackground,
} from '../../lib/rest-timer-store';
import {
  AUTO_ADVANCE_WARNING_LEAD_MS,
  getAutoAdvanceDeadlineMs,
  isAutoAdvanceDeadlineStale,
  shouldScheduleAutoAdvance,
} from '../../lib/rest-timer-auto-advance';

const KEEP_AWAKE_TAG = 'rest-timer';

/** The scheduler pages only the committed track; it has no preview to update. */
const keepPreviewSource: Dispatch<SetStateAction<PlaylistSuggestionSource | null>> = () => {};

export function RestTimerAutoAdvanceScheduler() {
  const { t } = useTranslation('session');
  const timerState = useRestTimerState();
  const { targetSeconds, autoAdvance, mode } = useEffectiveRestPacing();

  const { nextClimb, getQueueSnapshot, refreshPlaylistSuggestionSource } = useQueueActions();
  const { queue, currentClimbQueueItem } = useQueueData();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  // A long list keeps going with the player closed too (#6664): the player
  // pages the track only while it is open, and a hands-free session walks the
  // list from here. The page is asked for well before the last loaded climb, so
  // it has landed by the time a beat gets there.
  const getCommittedSuggestionSource = useCallback(
    () => getQueueSnapshot().playlistSuggestionSource,
    [getQueueSnapshot],
  );
  useTrackPaging({
    source: playlistSuggestionSource,
    displayedClimbUuid: currentClimbQueueItem?.climb?.uuid,
    previewTrack: false,
    setPreviewSource: keepPreviewSource,
    getCommittedSource: getCommittedSuggestionSource,
    refreshCommittedSource: refreshPlaylistSuggestionSource,
  });
  const { data: activeBoard } = useActiveBoard();
  // The beat has to agree with what a swipe would actually do: without this it
  // announces "queue ended" while `nextClimb` would happily advance onto a climb
  // at the other board in this gym.
  const reachableBoardKeys = useReachableBoardKeys(activeBoard);
  const isReachable = useMemo(() => {
    if (reachableBoardKeys.size === 0) return undefined;
    return (climb: { boardType?: string | null; layoutId?: number | null }) =>
      isClimbOnReachableBoard(climb, reachableBoardKeys);
  }, [reachableBoardKeys]);
  // The scheduled callback fires long after the render that armed it.
  const isReachableRef = useRef(isReachable);
  isReachableRef.current = isReachable;
  const { showToast } = useToast();

  // In a crew, only the climber driving the wall may move the shared queue —
  // `nextClimb` broadcasts, so a passenger's timer would change everyone's climb.
  // Solo there is nothing to stomp on, so no board link is required. One rule,
  // shared with the sheet: lib/session-timer/driver-rule.ts.
  const { canAdvanceQueue: canDriveWall } = useSessionTimerDriver();

  // Read through refs so the scheduling effect depends only on the timer's own
  // inputs. Re-running it on every queue edit would cancel and reschedule the
  // pending advance constantly, and a queue edit is not a reason to restart a rest.
  // The dead-end message is resolved HERE, with the `t` react-i18next bound, and
  // carried as a finished string. Calling `inputs.t('...')` inside the callback
  // instead would read as a property access to `check:i18n:orphans`, which can
  // only bind a plain `t(...)` identifier call — and the key would be reported
  // as orphaned even though it is used.
  const queueEndedMessage = t('mobile.restTimer.queueEndedToast');
  // A list's end is not the queue's: what is queued is still there, one tap on
  // the player's end card away (#6664).
  const listEndedMessage = t('mobile.restTimer.listEndedToast');
  const advanceInputsRef = useRef({
    queue,
    currentClimbQueueItem,
    playlistSuggestionSource,
    activeBoard,
    showToast,
    queueEndedMessage,
    listEndedMessage,
  });
  advanceInputsRef.current = {
    queue,
    currentClimbQueueItem,
    playlistSuggestionSource,
    activeBoard,
    showToast,
    queueEndedMessage,
    listEndedMessage,
  };

  // A beat that came due at the end of what is loaded while more of the list is
  // still on its way. Taken when the page lands (see the effect below).
  const awaitingPageRef = useRef<{ cycleId: number; deadlineMs: number } | null>(null);

  const fireAdvance = useCallback(
    (expectedCycleId: number, scheduledDeadlineMs: number, afterPage = false) => {
      // A beat that waited for a page came due while the climber watched, so
      // its deadline is late on purpose, not stale.
      //
      // ORDERING-PROOF background guard. Nothing orders the AppState 'active'
      // listener ahead of the timer queue on resume — RN flushes both off the
      // same UIApplicationDidBecomeActive, in no guaranteed order — so a timeout
      // that came due while the phone was in a pocket can land here first. Check
      // the deadline rather than trusting the listener to have re-anchored.
      if (!afterPage && isAutoAdvanceDeadlineStale(scheduledDeadlineMs, nowMs())) {
        reanchorRestTimerAfterBackground(nowMs(), scheduledDeadlineMs);
        return;
      }

      const inputs = advanceInputsRef.current;
      const activeConfig = inputs.activeBoard
        ? (() => {
            const boardName = toBoardName(inputs.activeBoard.boardType);
            return boardName ? { boardName, layoutId: inputs.activeBoard.layoutId } : undefined;
          })()
        : undefined;

      // `nextClimb` is a SILENT no-op at a dead end, so never call it blind —
      // the beat would keep running with the wall never changing and nothing
      // said. Ask the same selector the play drawer uses for its Next affordance.
      const { canNext, atTrackEnd } = computeNavigationStateWithSuggestions(
        inputs.queue,
        inputs.currentClimbQueueItem,
        inputs.playlistSuggestionSource,
        activeConfig,
        isReachableRef.current,
      );

      if (!canNext) {
        // More of the list is still on its way: wait for it without a word, and
        // take this beat when it lands. Latching "ended" instead would say "End
        // of the list" meanwhile, and clearing the latch re-anchors the rest, so
        // the climber would wait one whole rest more (#6664 second review).
        if (atTrackEnd && canLoadMoreOfTrack(inputs.playlistSuggestionSource)) {
          awaitingPageRef.current = { cycleId: expectedCycleId, deadlineMs: scheduledDeadlineMs };
          return;
        }
        noteRestTimerQueueEnded({ listEnded: atTrackEnd });
        inputs.showToast(atTrackEnd ? inputs.listEndedMessage : inputs.queueEndedMessage, 'info');
        return;
      }

      // Claim the cycle BEFORE advancing: a stale timeout from a re-run effect
      // or a remount loses the race here rather than skipping a second climb.
      if (!noteRestTimerAutoAdvanceFired(expectedCycleId, mode, nowMs(), scheduledDeadlineMs)) return;

      playRestTimerCue({ kind: 'advance' });
      nextClimb();
    },
    [mode, nextClimb],
  );

  const wantsAdvance = shouldScheduleAutoAdvance({ state: timerState, targetSeconds, autoAdvance, canDriveWall });
  const candidateDeadlineMs = wantsAdvance
    ? getAutoAdvanceDeadlineMs({
        mode,
        anchorMs: timerState.anchorMs,
        targetSeconds,
        nowMs: nowMs(),
        lastFiredDeadlineMs: timerState.lastFiredDeadlineMs,
      })
    : null;

  // A deadline already long past means the anchor is a back-dated tick — the
  // climber logged yesterday's session with the date picker. Treat that as NOT
  // scheduled rather than arming a pointless timer: otherwise the timer wedges
  // (no advance, and the target buzz below stays suppressed because it is gated
  // on nothing being pending) and the screen-wake lock is held for nothing.
  const deadlineStale = isAutoAdvanceDeadlineStale(candidateDeadlineMs, nowMs());
  const scheduled = wantsAdvance && !deadlineStale;
  const deadlineMs = scheduled ? candidateDeadlineMs : null;

  // Keep the screen up while an advance is pending: timers are suspended in the
  // background and BLE writes need the app active, so a sleeping phone is a
  // timer that silently stops.
  useKeepAwakeWhile(scheduled, KEEP_AWAKE_TAG);

  const { cycleId } = timerState;
  useEffect(() => {
    if (deadlineMs === null) return undefined;

    const remainingMs = deadlineMs - nowMs();
    // Due within the grace window but already past — schedule nothing rather
    // than firing on the spot. Anything further past than the grace never gets
    // here: `deadlineStale` above already read it as not-scheduled.
    if (remainingMs <= 0) return undefined;

    const warnTimeout =
      remainingMs > AUTO_ADVANCE_WARNING_LEAD_MS
        ? setTimeout(() => playRestTimerCue({ kind: 'warning' }), remainingMs - AUTO_ADVANCE_WARNING_LEAD_MS)
        : null;
    const fireTimeout = setTimeout(() => fireAdvance(cycleId, deadlineMs), remainingMs);

    return () => {
      if (warnTimeout !== null) clearTimeout(warnTimeout);
      clearTimeout(fireTimeout);
    };
  }, [cycleId, deadlineMs, fireAdvance]);

  // Target reached with auto-advance off: one haptic, and the digits go red (the
  // colour lives in the pill). Never while an advance is pending, so the two cues
  // can't double up.
  //
  // The latch is keyed on the TARGET as well as the cycle: lengthening the rest
  // mid-cycle (1 min → 5 min) is a new mark to reach, and a cycle-only latch
  // swallowed it silently.
  const reachedRef = useRef<{ cycleId: number; targetSeconds: number } | null>(null);
  const { anchorMs, armed, isRunning } = timerState;
  useEffect(() => {
    if (!armed || !isRunning || scheduled) return undefined;
    if (anchorMs === null || targetSeconds === null || targetSeconds <= 0) return undefined;
    if (reachedRef.current?.cycleId === cycleId && reachedRef.current.targetSeconds === targetSeconds) return undefined;

    const remainingMs = anchorMs + targetSeconds * 1000 - nowMs();
    if (remainingMs <= 0) {
      reachedRef.current = { cycleId, targetSeconds };
      return undefined;
    }

    const timeout = setTimeout(() => {
      reachedRef.current = { cycleId, targetSeconds };
      playRestTimerCue({ kind: 'reached' });
    }, remainingMs);
    return () => clearTimeout(timeout);
  }, [anchorMs, armed, cycleId, isRunning, scheduled, targetSeconds]);

  // The page a due beat was waiting for has landed (or the track ended): try the
  // beat again. Only for the cycle it was due in; a manual Next or a new tick
  // starts another cycle, and the claim inside would refuse it anyway. Only
  // while the beat would still be scheduled: pausing, switching auto-advance
  // off or handing the wall to a crewmate meanwhile drops it, so a late page
  // can't move a shared queue from a passenger's phone.
  useEffect(() => {
    const awaiting = awaitingPageRef.current;
    if (!awaiting) return;
    awaitingPageRef.current = null;
    if (!wantsAdvance || cycleId !== awaiting.cycleId) return;
    fireAdvance(awaiting.cycleId, awaiting.deadlineMs, true);
  }, [playlistSuggestionSource, wantsAdvance, cycleId, fireAdvance]);

  // The queue was refilled (or the board switched) while the dead-end latch was
  // set. Pick the beat back up instead of staying dead until the next tick. Only
  // runs while latched, so the O(queue) walk is rare and bounded.
  const { queueEnded } = timerState;
  useEffect(() => {
    if (!armed || !queueEnded) return;
    const inputs = advanceInputsRef.current;
    const activeConfig = inputs.activeBoard
      ? (() => {
          const boardName = toBoardName(inputs.activeBoard.boardType);
          return boardName ? { boardName, layoutId: inputs.activeBoard.layoutId } : undefined;
        })()
      : undefined;
    const { canNext } = computeNavigationStateWithSuggestions(
      inputs.queue,
      inputs.currentClimbQueueItem,
      inputs.playlistSuggestionSource,
      activeConfig,
      isReachable,
    );
    if (canNext) clearRestTimerQueueEnded(nowMs(), mode);
  }, [armed, mode, queue, currentClimbQueueItem, playlistSuggestionSource, activeBoard, queueEnded, isReachable]);

  // Coming back from the background, a deadline that passed while away was never
  // actionable. Re-anchor and start a fresh cycle rather than moving the wall for
  // an interval the climber never watched.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState !== 'active') return;
      reanchorRestTimerAfterBackground(nowMs(), deadlineMs);
    });
    return () => subscription.remove();
  }, [deadlineMs]);

  return null;
}
