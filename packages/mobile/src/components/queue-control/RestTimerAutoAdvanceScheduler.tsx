// Fires the rest timer's auto-advance (#5378). Renders nothing and sets no state
// per tick: it owns ONE `setTimeout` for the exact remaining milliseconds, plus
// at most five for the final countdown's cues (#5396), so a running timer costs
// the app tree nothing between beats.
//
// Everything here is a guard. The failure mode this component can produce is
// "the wall changed under a climber", so each rule below is paired with a test
// that asserts it does NOT fire.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
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
import { anchorAfterFire, restAdvanceAllowed } from '../../lib/rest-timer-pacing';
import {
  clearRestTimerQueueEnded,
  floorRestTimerAnchorAtLastAdvance,
  getRestTimerState,
  noteRestTimerAdvancedFrom,
  noteRestTimerAutoAdvanceFired,
  noteRestTimerCrewBeatSkipped,
  noteRestTimerQueueEnded,
  reanchorRestTimerAfterBackground,
} from '../../lib/rest-timer-store';
import {
  AUTO_ADVANCE_OVERDUE_GRACE_MS,
  getAfterTickRestFloorMs,
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
import type { SetSessionRestCadencePayload } from '@boardsesh/shared-schema/generated';
import {
  CREW_FIRE_LATE_TOLERANCE_MS,
  CREW_FIRE_TIMEOUT_MS,
  crewBeatFenced,
  crewBeatServerMs,
  handleCrewCadenceChange,
  planCrewFireOutcome,
  type CrewRestCadence,
} from '../../lib/crew-rest-cadence';
import { serverToLocalMs } from '../../lib/server-clock';
import { reportHandledError } from '../../lib/error-reporting';

const KEEP_AWAKE_TAG = 'rest-timer';

/** A crew repair waits this long past the 5 s claim window, so the server agrees the beat is gone. */
const CREW_REPAIR_MARGIN_MS = 250;

/**
 * The whole FIRE, rejoin included, within CREW_FIRE_TIMEOUT_MS. The mutation's
 * own timeout starts only once the session is joined, and a rejoin over a dead
 * connection can take the transport's full 30 s: a beat answered that late is
 * no use to anyone.
 */
async function withinCrewFireTimeout<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Crew FIRE got no answer within ${CREW_FIRE_TIMEOUT_MS} ms`)),
      CREW_FIRE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([request, timedOut]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Whether the crew's clock still has this beat due: running, moving the wall,
 * and with the same anchor and length the FIRE claimed it on. A crewmate who
 * paused it, changed it or switched auto-advance off since keeps what they did.
 */
function crewBeatStillDue(crew: CrewRestCadence, localDeadlineMs: number, beatServerMs: number): boolean {
  return (
    crew.isRunning &&
    crew.config !== null &&
    crew.config.autoAdvance &&
    crewBeatServerMs(crew, localDeadlineMs) === beatServerMs
  );
}

/** The scheduler pages only the committed track; it has no preview to update. */
const keepPreviewSource: Dispatch<SetStateAction<PlaylistSuggestionSource | null>> = () => {};

export function RestTimerAutoAdvanceScheduler() {
  const { t } = useTranslation('session');
  const timerState = useRestTimerState();
  const { targetSeconds, autoAdvance, mode, advanceOn, stage } = useEffectiveRestPacing();

  const { nextClimb, getQueueSnapshot, refreshPlaylistSuggestionSource, setSessionRestCadence } = useQueueActions();
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
  //
  // A crew clock this app cannot run (an unknown mode or rule) moves nothing.
  const { canAdvanceQueue, role } = useSessionTimerDriver();
  const canDriveWall = canAdvanceQueue && timerState.crew?.config !== null;
  // The fire and the foreground callbacks land long after the render, and the
  // board can change hands meanwhile.
  const roleRef = useRef(role);
  roleRef.current = role;
  /** Whether this phone paces a crew clock right now (read in callbacks, after the render). */
  const pacesTheCrew = useCallback(() => roleRef.current === 'holder' || roleRef.current === 'solo', []);

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

  // The crew clock's FIRE (#5382, contracts §10). With a crew clock, the server
  // claims each beat once for the whole session (compare-and-set on the
  // revision), and only an applied claim moves the wall, so two phones that
  // both think they pace can never both advance. A refusal that can still land
  // (the server's clock not at the beat yet, or another write first) retries
  // the same beat; one more than 5 s gone is lost. A holder that hears nothing
  // back lets the beat go; a phone alone in its session moves the wall itself
  // rather than stall on a dead connection.
  const crewFireInFlightRef = useRef(false);
  const crewTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const mountedRef = useRef(true);
  const fireAdvanceRef = useRef<
    ((expectedCycleId: number, scheduledDeadlineMs: number, afterPage?: boolean, crewAttempt?: number) => void) | null
  >(null);
  useEffect(() => {
    mountedRef.current = true;
    const crewTimers = crewTimersRef.current;
    return () => {
      mountedRef.current = false;
      for (const timer of crewTimers) clearTimeout(timer);
      crewTimers.clear();
    };
  }, []);
  const scheduleCrewTimer = useCallback((callback: () => void, delayMs: number) => {
    const timer = setTimeout(
      () => {
        crewTimersRef.current.delete(timer);
        callback();
      },
      Math.max(0, delayMs),
    );
    crewTimersRef.current.add(timer);
  }, []);

  /**
   * The local claim and the advance, for a phone that moves the wall itself:
   * no crew clock, or a solo phone whose FIRE never got an answer. The claim
   * also tells the crew publisher, which puts the shared clock's rest in step.
   */
  const advanceLocally = useCallback(
    (expectedCycleId: number, scheduledDeadlineMs: number) => {
      // Claim the cycle BEFORE advancing: a stale timeout from a re-run effect
      // or a remount loses the race here rather than skipping a second climb.
      // Under a tick or send rule the claim also clears the anchor and the tick,
      // so the next climb rests only once it is logged.
      const anchorAfter = anchorAfterFire({ mode, advanceOn });
      if (!noteRestTimerAutoAdvanceFired(expectedCycleId, mode, nowMs(), scheduledDeadlineMs, anchorAfter)) return;

      // The tick that earned this move is spent: should the wall come back to
      // this climb without a new one, it never moves on again from it.
      noteRestTimerAdvancedFrom(advanceInputsRef.current.currentClimbQueueItem?.uuid ?? null);
      playRestTimerCue({ kind: 'advance' });
      nextClimb();
    },
    [mode, advanceOn, nextClimb],
  );

  /**
   * A crew beat this phone let go without moving the wall. On the minute the
   * crew's beat never moves here, so this one is marked spent and the scheduler
   * goes on to the next: nothing else in the store changed, and it would sit on
   * the beat that went. After a tick the rest stays on a deadline nobody can
   * claim once 5 s have gone, so it restarts then, as coming back from the
   * background would (contracts §10), while the server's clock still has the
   * beat due and this phone still paces it.
   */
  const letCrewBeatGo = useCallback(
    (crew: CrewRestCadence, localDeadlineMs: number, beatServerMs: number) => {
      if (crew.config?.mode === 'onTheMinute') {
        noteRestTimerCrewBeatSkipped(localDeadlineMs);
        return;
      }
      scheduleCrewTimer(
        () => {
          const currentCrew = getRestTimerState().crew;
          if (currentCrew === null || !pacesTheCrew()) return;
          if (!crewBeatStillDue(currentCrew, localDeadlineMs, beatServerMs)) return;
          reanchorRestTimerAfterBackground(nowMs(), localDeadlineMs);
        },
        serverToLocalMs(beatServerMs + CREW_FIRE_LATE_TOLERANCE_MS) + CREW_REPAIR_MARGIN_MS - nowMs(),
      );
    },
    [pacesTheCrew, scheduleCrewTimer],
  );

  const fireCrewBeat = useCallback(
    async ({
      expectedCycleId,
      deadlineMs: localDeadlineMs,
      attempt,
    }: {
      expectedCycleId: number;
      deadlineMs: number;
      attempt: number;
    }) => {
      const before = getRestTimerState();
      const crew = before.crew;
      if (crew === null || crew.config === null || before.cycleId !== expectedCycleId) return;
      if (crewFireInFlightRef.current) return;
      const beatServerMs = crewBeatServerMs(crew, localDeadlineMs);
      if (beatServerMs === null) return;
      // Too close to the last beat the server took for it ever to take this one
      // (its spacing fence, #6754): a FIRE, or a retry, would only be refused.
      // The beat goes as one refused would.
      if (crewBeatFenced(crew.config, crew.lastFiredBeatServerMs, beatServerMs)) {
        playRestTimerCue({ kind: 'reached' });
        letCrewBeatGo(crew, localDeadlineMs, beatServerMs);
        return;
      }
      // The climb this beat moves on from: a crewmate who moves the wall by hand
      // while the claim is in flight has already spent the beat.
      const wallQueueItemUuid = advanceInputsRef.current.currentClimbQueueItem?.uuid ?? null;
      const alone = roleRef.current === 'solo';

      // No answer: an error, the 2 s timeout, or no session to send it on.
      const beatGotNoAnswer = () => {
        if (alone) {
          // Nobody else to claim it: the wall moves from here, as long as the
          // beat is still one the climber is watching.
          if (!isAutoAdvanceDeadlineStale(localDeadlineMs, nowMs())) advanceLocally(expectedCycleId, localDeadlineMs);
          else letCrewBeatGo(crew, localDeadlineMs, beatServerMs);
          return;
        }
        // The beat is skipped; the server may not have taken it either.
        playRestTimerCue({ kind: 'reached' });
        letCrewBeatGo(crew, localDeadlineMs, beatServerMs);
      };

      crewFireInFlightRef.current = true;
      const sentAtMs = nowMs();
      let payload: SetSessionRestCadencePayload | null;
      try {
        payload = await withinCrewFireTimeout(
          setSessionRestCadence(
            {
              action: 'FIRE',
              expectedRevision: crew.revision,
              firedBeatAgoMs: Math.max(0, Math.round(sentAtMs - localDeadlineMs)),
            },
            { timeoutMs: CREW_FIRE_TIMEOUT_MS, retryWhenRateLimited: false },
          ),
        );
      } catch (error) {
        crewFireInFlightRef.current = false;
        reportHandledError(error, { tags: { source: 'crew-rest-clock', op: 'fire' } });
        if (mountedRef.current) beatGotNoAnswer();
        return;
      }
      crewFireInFlightRef.current = false;
      if (!mountedRef.current) return;
      if (payload === null) {
        beatGotNoAnswer();
        return;
      }

      handleCrewCadenceChange(payload.change, {
        sessionId: crew.sessionId,
        // Only this phone's own clock fires, so it is armed for it: the
        // adoption rule needs no participant id here.
        ownParticipantId: null,
        receivedAtMs: nowMs(),
        sentAtMs,
      });
      const outcome = planCrewFireOutcome({ applied: payload.applied, change: payload.change, beatServerMs, attempt });
      switch (outcome.kind) {
        case 'advance':
          if ((advanceInputsRef.current.currentClimbQueueItem?.uuid ?? null) !== wallQueueItemUuid) return;
          noteRestTimerAdvancedFrom(wallQueueItemUuid);
          playRestTimerCue({ kind: 'advance' });
          nextClimb();
          return;
        case 'retry': {
          const retryCycleId = getRestTimerState().cycleId;
          const retryDeadlineMs = serverToLocalMs(beatServerMs);
          scheduleCrewTimer(
            () => fireAdvanceRef.current?.(retryCycleId, retryDeadlineMs, false, attempt + 1),
            serverToLocalMs(outcome.atServerMs) - nowMs(),
          );
          return;
        }
        // Too late by the server's clock, so nobody can claim the beat now; or
        // the clock no longer has it, or the retries ran out.
        case 'lost':
        case 'refused':
          playRestTimerCue({ kind: 'reached' });
          letCrewBeatGo(crew, localDeadlineMs, beatServerMs);
          return;
        case 'claimed':
          return;
        default: {
          const unhandled: never = outcome;
          throw new Error(`Unhandled crew fire outcome: ${JSON.stringify(unhandled)}`);
        }
      }
    },
    [advanceLocally, letCrewBeatGo, nextClimb, scheduleCrewTimer, setSessionRestCadence],
  );

  const fireAdvance = useCallback(
    (expectedCycleId: number, scheduledDeadlineMs: number, afterPage = false, crewAttempt = 0) => {
      // A beat that waited for a page came due while the climber watched, so
      // its deadline is late on purpose, not stale.
      //
      // ORDERING-PROOF background guard. Nothing orders the AppState 'active'
      // listener ahead of the timer queue on resume — RN flushes both off the
      // same UIApplicationDidBecomeActive, in no guaranteed order — so a timeout
      // that came due while the phone was in a pocket can land here first. Check
      // the deadline rather than trusting the listener to have re-anchored.
      if (!afterPage && isAutoAdvanceDeadlineStale(scheduledDeadlineMs, nowMs())) {
        // A crew clock is the crew's: only the phone that paces it restarts it.
        if (getRestTimerState().crew === null || pacesTheCrew()) {
          reanchorRestTimerAfterBackground(nowMs(), scheduledDeadlineMs);
        }
        // A crew's beat on the minute never moves here: spend the stale one, so
        // the next beat gets scheduled.
        noteRestTimerCrewBeatSkipped(scheduledDeadlineMs);
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

      // A tick or send rule asks again at the fire, against the climb on the
      // wall NOW: a manual Next that lands just before the timeout leaves the new
      // climb without its tick, and walking on from it would skip a climb. A 4x4
      // set asks for its reps the same way, and a climb the wall already moved
      // on from is never moved on from again on the same tick.
      const { lastTick, crew, stagePacing, advancedFromQueueItemUuid } = getRestTimerState();
      const currentQueueItemUuid = inputs.currentClimbQueueItem?.uuid ?? null;
      if (
        !restAdvanceAllowed({
          advanceOn,
          currentQueueItemUuid,
          lastTick,
          stage: stagePacing,
          advancedFromQueueItemUuid,
        })
      ) {
        return;
      }

      if (crew !== null) {
        // The server claims the beat (see fireCrewBeat). A clock this app
        // cannot run, or a phone that no longer paces it, moves nothing.
        if (crew.config === null || !pacesTheCrew()) return;
        void fireCrewBeat({ expectedCycleId, deadlineMs: scheduledDeadlineMs, attempt: crewAttempt });
        return;
      }

      advanceLocally(expectedCycleId, scheduledDeadlineMs);
    },
    [advanceOn, advanceLocally, fireCrewBeat, pacesTheCrew],
  );
  fireAdvanceRef.current = fireAdvance;

  // A workout stage's tick or send rule: the rest only moves the wall once the
  // climb on it was logged (limit: sent; a 4x4: every rep of the set).
  // Otherwise the rest runs out with the reached cue below and the climb stays up.
  const wantsAdvance =
    shouldScheduleAutoAdvance({ state: timerState, targetSeconds, autoAdvance, canDriveWall }) &&
    restAdvanceAllowed({
      advanceOn,
      currentQueueItemUuid: currentClimbQueueItem?.uuid ?? null,
      lastTick: timerState.lastTick,
      stage,
      advancedFromQueueItemUuid: timerState.advancedFromQueueItemUuid,
    });
  // A crew beat on the minute this phone let go is spent for the walk and the
  // reached cue below, but it never counts as an advance (crewBeatSkippedMs):
  // the rest floor reads only the real ones.
  const lastBeatHandledMs =
    mode === 'onTheMinute' && timerState.crewBeatSkippedMs !== null
      ? Math.max(timerState.lastFiredDeadlineMs ?? timerState.crewBeatSkippedMs, timerState.crewBeatSkippedMs)
      : timerState.lastFiredDeadlineMs;
  // One clock read for the three rules below, so the deadline, its staleness
  // and the rest floor always agree within a render.
  const renderNowMs = nowMs();
  const candidateDeadlineMs = wantsAdvance
    ? getAutoAdvanceDeadlineMs({
        mode,
        anchorMs: timerState.anchorMs,
        targetSeconds,
        nowMs: renderNowMs,
        lastFiredDeadlineMs: lastBeatHandledMs,
      })
    : null;

  // A deadline already long past means the anchor is a back-dated tick — the
  // climber logged yesterday's session with the date picker. Treat that as NOT
  // scheduled rather than arming a pointless timer: otherwise the timer wedges
  // (no advance, and the target buzz below stays suppressed because it is gated
  // on nothing being pending) and the screen-wake lock is held for nothing.
  const deadlineStale = isAutoAdvanceDeadlineStale(candidateDeadlineMs, renderNowMs);
  const scheduled = wantsAdvance && !deadlineStale;
  const deadlineMs = scheduled ? candidateDeadlineMs : null;

  // A running after-tick rest that began before the last advance counts from
  // it, less 3 s (`getAfterTickRestFloorMs`); the deadline above already does.
  // Written into the store the first time it applies, before paint, so the pill
  // reaches 0:00 as the wall moves, a pause freezes that rest, and the rest
  // never flips back to its own anchor once that one's end goes by.
  const restFloorMs = wantsAdvance
    ? getAfterTickRestFloorMs({
        mode,
        anchorMs: timerState.anchorMs,
        targetSeconds,
        nowMs: renderNowMs,
        lastFiredDeadlineMs: timerState.lastFiredDeadlineMs,
      })
    : null;
  useLayoutEffect(() => {
    if (restFloorMs === null) return;
    floorRestTimerAnchorAtLastAdvance(timerState.cycleId, mode, targetSeconds, nowMs());
  }, [mode, restFloorMs, targetSeconds, timerState.cycleId]);

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

  // A crew rest after a tick whose deadline this phone paces but will never fire
  // on: it was already past when the phone took the board over, or when the
  // crew's clock came in (a crewmate's send logged a whole rest late). Nothing
  // is scheduled for a deadline already past, and nobody can claim one more
  // than 5 s gone, so the whole crew's rest would sit on it until the next
  // tick. Restart it once nobody can claim it, as coming back from the
  // background does (contracts §10). A FIRE in flight, or a retry or restart
  // already waiting, settles the beat itself.
  const pacesCrewRestAfterTick =
    timerState.crew?.config?.mode === 'afterTick' && (role === 'holder' || role === 'solo');
  const missedCrewDeadlineMs =
    pacesCrewRestAfterTick && candidateDeadlineMs !== null && candidateDeadlineMs <= nowMs()
      ? candidateDeadlineMs
      : null;
  useEffect(() => {
    if (missedCrewDeadlineMs === null) return undefined;
    const restartCrewRest = () => {
      if (crewFireInFlightRef.current || crewTimersRef.current.size > 0) return;
      if (getRestTimerState().cycleId !== cycleId) return;
      reanchorRestTimerAfterBackground(nowMs(), missedCrewDeadlineMs);
    };
    const untilUnclaimableMs = missedCrewDeadlineMs + AUTO_ADVANCE_OVERDUE_GRACE_MS + CREW_REPAIR_MARGIN_MS - nowMs();
    if (untilUnclaimableMs <= 0) {
      restartCrewRest();
      return undefined;
    }
    const timeout = setTimeout(restartCrewRest, untilUnclaimableMs);
    return () => clearTimeout(timeout);
  }, [cycleId, missedCrewDeadlineMs]);

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
  const { anchorMs, armed, isRunning } = timerState;
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
    lastBeatHandledMs === null
      ? reachedLatch.handledThroughMs
      : Math.max(reachedLatch.handledThroughMs, lastBeatHandledMs);
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
    if (canNext) clearRestTimerQueueEnded(nowMs(), mode, anchorAfterFire({ mode, advanceOn }));
  }, [
    armed,
    mode,
    advanceOn,
    queue,
    currentClimbQueueItem,
    playlistSuggestionSource,
    activeBoard,
    queueEnded,
    isReachable,
  ]);

  // Coming back from the background, a deadline that passed while away was never
  // actionable. Re-anchor and start a fresh cycle rather than moving the wall for
  // an interval the climber never watched.
  //
  // With a crew clock only the phone pacing it restarts it (the crew publisher
  // sends the restart on); a phone that handed the board over while it was
  // away must not move everyone's rest. The role is read now, not as it was
  // when the listener was set up, since the board can change hands meanwhile.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState !== 'active') return;
      if (getRestTimerState().crew !== null && !pacesTheCrew()) return;
      reanchorRestTimerAfterBackground(nowMs(), deadlineMs);
    });
    return () => subscription.remove();
  }, [deadlineMs, pacesTheCrew]);

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
