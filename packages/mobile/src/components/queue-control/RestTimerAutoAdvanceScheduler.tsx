// Fires the rest timer's auto-advance (#5378). Renders nothing and sets no state
// per tick: it owns ONE `setTimeout` for the exact remaining milliseconds, plus
// at most five for the final countdown's cues (#5396), so a running timer costs
// the app tree nothing between beats.
//
// Everything here is a guard. The failure mode this component can produce is
// "the wall changed under a climber", so each rule below is paired with a test
// that asserts it does NOT fire.

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
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
  getAutoAdvanceDeadlineMs,
  getRestTimerCountdownCueTimes,
  getRestTimerCountdownLeadSeconds,
  getRestTimerReachedAtMs,
  isAutoAdvanceDeadlineStale,
  isRestTimerCueLate,
  isRestTimerReachedCueLate,
  shouldScheduleAutoAdvance,
} from '../../lib/rest-timer-auto-advance';
import { useSetting } from '../../settings';

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

  // The final countdown (#5396). The lead scales with the rest, and each second
  // of it is a cue, or a single warning with per-second cues off. The choice is
  // made once per rest, by the first cue that lands, and kept for the rest's
  // instant: a toggle or a re-run effect mid-countdown can never play ticks AND
  // the warning for one rest.
  const [countdownCues] = useSetting('restTimerCountdownCues');
  const leadSeconds = getRestTimerCountdownLeadSeconds(targetSeconds);
  const countdownCuesRef = useRef(countdownCues);
  countdownCuesRef.current = countdownCues;
  const leadCueChoiceRef = useRef<{ targetAtMs: number; countdown: boolean } | null>(null);
  const chooseCountdown = useCallback((targetAtMs: number) => {
    if (leadCueChoiceRef.current?.targetAtMs !== targetAtMs) {
      leadCueChoiceRef.current = { targetAtMs, countdown: countdownCuesRef.current };
    }
    return leadCueChoiceRef.current.countdown;
  }, []);

  const { cycleId } = timerState;
  useEffect(() => {
    if (deadlineMs === null) return undefined;

    const scheduledAtMs = nowMs();
    const remainingMs = deadlineMs - scheduledAtMs;
    // Due within the grace window but already past — schedule nothing rather
    // than firing on the spot. Anything further past than the grace never gets
    // here: `deadlineStale` above already read it as not-scheduled.
    if (remainingMs <= 0) return undefined;

    const timeouts = scheduleLeadCues(deadlineMs, leadSeconds, scheduledAtMs, chooseCountdown);
    timeouts.push(setTimeout(() => fireAdvance(cycleId, deadlineMs), remainingMs));
    return () => clearCueTimeouts(timeouts);
  }, [chooseCountdown, cycleId, deadlineMs, fireAdvance, leadSeconds]);

  // The rest ran out and nothing moved the wall: auto-advance off, a crew
  // passenger, or the end of the queue or the list. The same countdown, then one
  // `reached` cue, and the digits go red (the colour lives in the pill). Never
  // while an advance is pending, so the two terminal cues can't double up.
  //
  // The latch belongs to one rest, and a rest is its anchor: a re-arm, a reset,
  // a new tick, an after-tick advance and a resume each count from a new one, so
  // nothing an earlier rest cued carries over. A rest starts handled through the
  // moment this scheduler first saw its anchor, so a mark that went by before
  // then is never cued late: before a pause (Resume rebases the anchor on the
  // paused elapsed), before this mount, behind a back-dated tick. Within a rest
  // the latch is the INSTANT that was cued, not the cycle: lengthening the rest
  // mid-cycle (1 min → 5 min) is a new mark to reach, and on the minute every
  // beat is one. An advance that fired on a beat already had its cue, so that
  // beat counts as cued too. State, not a ref, so the wake lock below lets go
  // once the cue has played.
  const { anchorMs, armed, isRunning, lastFiredDeadlineMs } = timerState;
  const atDeadEnd = timerState.queueEnded;
  const renderedAtMs = nowMs();
  const [storedReachedLatch, setReachedLatch] = useState<ReachedLatch>(() => ({
    anchorMs,
    handledThroughMs: renderedAtMs,
  }));
  let reachedLatch = storedReachedLatch;
  if (!Object.is(reachedLatch.anchorMs, anchorMs)) {
    // A new rest. Adopted during render, so no effect below ever runs with the
    // last rest's latch (`Object.is`, so a NaN anchor cannot loop the render).
    reachedLatch = { anchorMs, handledThroughMs: renderedAtMs };
    setReachedLatch(reachedLatch);
  }
  const handledThroughMs =
    lastFiredDeadlineMs === null
      ? reachedLatch.handledThroughMs
      : Math.max(reachedLatch.handledThroughMs, lastFiredDeadlineMs);
  const reachedAtMs =
    armed && isRunning && !scheduled
      ? getRestTimerReachedAtMs({ mode, anchorMs, targetSeconds, nowMs: renderedAtMs, handledThroughMs })
      : null;
  useEffect(() => {
    if (reachedAtMs === null) return undefined;

    // The terminal cue keeps the advance's grace, not the countdown's 750 ms:
    // a rest end that lands a second late still gets `advance`, so it still
    // gets `reached` too.
    const cueReached = () => {
      setReachedLatch({ anchorMs, handledThroughMs: reachedAtMs });
      if (!isRestTimerReachedCueLate(reachedAtMs, nowMs())) playRestTimerCue({ kind: 'reached' });
    };
    const scheduledAtMs = nowMs();
    const remainingMs = reachedAtMs - scheduledAtMs;
    // Just went with no cue: the deadline that found the dead end, or a rest
    // shortened to what has already passed.
    if (remainingMs <= 0) {
      cueReached();
      return undefined;
    }
    // At a dead end the counting stops with the cue above; the beats after it
    // have nothing to count down to.
    if (atDeadEnd) return undefined;

    const timeouts = scheduleLeadCues(reachedAtMs, leadSeconds, scheduledAtMs, chooseCountdown);
    timeouts.push(setTimeout(cueReached, remainingMs));
    return () => clearCueTimeouts(timeouts);
  }, [anchorMs, atDeadEnd, chooseCountdown, leadSeconds, reachedAtMs]);

  // Keep the screen up while an advance is pending: timers are suspended in the
  // background and BLE writes need the app active, so a sleeping phone is a
  // timer that silently stops. A rest paced by a workout stage or the crew holds
  // it until its `reached` cue too (limit's "go" after a fall, a passenger's
  // beat). A climber's own rest with auto-advance off never held the screen and
  // still does not. Read again here, not at the top: that line is the pacing
  // seam's.
  const { source: pacingSource } = useEffectiveRestPacing();
  const reachedCuePending = reachedAtMs !== null && reachedAtMs > renderedAtMs && !atDeadEnd;
  useKeepAwakeWhile(scheduled || (reachedCuePending && pacingSource !== 'settings'), KEEP_AWAKE_TAG);

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

// The countdown's timeouts (#5396). Below the component so the hunks above stay
// where docs/rest-timer.md says each PR edits.

type CueTimeout = ReturnType<typeof setTimeout>;

/** The rest a `reached` latch belongs to (its anchor), and the latest instant of it that needs no cue. */
type ReachedLatch = { anchorMs: number | null; handledThroughMs: number };

/** Plays a countdown cue unless it landed late: a timeout flushed on resume says nothing. */
function playCueUnlessLate(cue: Parameters<typeof playRestTimerCue>[0], dueAtMs: number): void {
  if (isRestTimerCueLate(dueAtMs, nowMs())) return;
  playRestTimerCue(cue);
}

/**
 * The cues leading up to `targetAtMs`, one timeout per second of the lead (at
 * most five). Each asks `chooseCountdown` when it lands: a countdown plays a tick
 * every second, and without one only the first second plays, as the warning.
 * Only instants still ahead are scheduled, so a re-run effect never replays a
 * second that already went.
 */
function scheduleLeadCues(
  targetAtMs: number,
  leadSeconds: number,
  fromMs: number,
  chooseCountdown: (targetAtMs: number) => boolean,
): CueTimeout[] {
  return getRestTimerCountdownCueTimes(targetAtMs, leadSeconds)
    .filter(({ atMs }) => atMs > fromMs)
    .map(({ atMs, secondsLeft }) =>
      setTimeout(() => {
        if (chooseCountdown(targetAtMs)) playCueUnlessLate({ kind: 'countdownTick', secondsLeft }, atMs);
        else if (secondsLeft === leadSeconds) playCueUnlessLate({ kind: 'warning' }, atMs);
      }, atMs - fromMs),
    );
}

function clearCueTimeouts(timeouts: CueTimeout[]): void {
  for (const timeout of timeouts) clearTimeout(timeout);
}
