// Runtime state for the rest timer (#5378), as a module singleton read through
// `useSyncExternalStore`.
//
// WHY NOT A PROVIDER: three concerns run at three different frequencies here —
// machine state (discrete events), the mm:ss display (1 Hz), and the auto-advance
// fire (once per cycle). A context whose value changed every second would
// re-render the whole app tree, which is the exact trap
// `docs/react-native-performance.md` §1 exists to prevent. So the machine state
// lives here, the 1 Hz ticker is local to the pill, and the fire is one
// `setTimeout` in a null-render component.
//
// WHAT IS **NOT** HERE: the target interval, the auto-advance switch and the
// cadence mode. Those are durable preferences and live in `../settings`. This
// store is purely "what is the timer doing right now", and none of it survives a
// cold start — see `armed` below.
//
// Two fields are context the timer runs in rather than its own state (#5380):
// `stagePacing`, the workout stage pacing of the climb on the wall, and
// `lastTick`, which climb the last tick was logged on and how it went. Readers
// merge the stage pacing with the settings through `useEffectiveRestPacing()`;
// the scheduler reads `lastTick` to decide whether a finished rest may move the
// wall under a tick or send rule (`restAdvanceAllowed`). Neither is persisted.

import { getRestTimerStartMs, type RestTimerMode } from './rest-timer';
import {
  sameStagePacing,
  type RestTimerLastTick,
  type RestTimerPacingTransition,
  type RestTimerStagePacing,
} from './rest-timer-pacing';

export type RestTimerState = {
  /**
   * Whether the climber has turned the timer on. Deliberately NOT persisted: a
   * flag set three weeks ago must never silently start moving someone's wall on
   * app open, and "hidden until armed" cannot survive a cold start.
   */
  armed: boolean;
  /**
   * The session this arm belongs to. `null` while armed means "armed on the
   * pre-session screen, for the session about to start" — `bindToSession` fills
   * it in when the session id appears.
   */
  armedForSessionId: string | null;
  /** What the countdown counts from. `null` = armed but nothing to count yet. */
  anchorMs: number | null;
  isRunning: boolean;
  /** Frozen elapsed while paused; meaningless while running. */
  pausedElapsedSeconds: number;
  /**
   * Monotonic. Every event that invalidates a pending auto-advance bumps it, and
   * the scheduler re-checks it inside its own callback before firing. It lives
   * in the store rather than a component ref so the guard survives a remount.
   */
  cycleId: number;
  /** Last tick we saw, for the display's "no tick yet" state and a11y copy. */
  lastTickAt: string | null;
  /**
   * Set when an auto-advance found nothing to advance to. Stops the scheduler
   * beating against an exhausted queue, and lets the UI say why. Cleared by the
   * next tick, and by the queue becoming advanceable again.
   */
  queueEnded: boolean;
  /**
   * Why the auto-advance stopped, read only while `queueEnded`: the climber
   * reached the end of the list they are walking, with their queue still there
   * behind it (issue #6664), rather than the end of the queue.
   */
  listEnded: boolean;
  /**
   * The deadline the last auto-advance actually fired on, so the next one can
   * never be scheduled at or before it.
   *
   * Without this, `onTheMinute` can advance TWICE for one beat: its deadline is
   * recomputed from the wall clock every render, and RN's timer queue runs on a
   * monotonic clock. If `Date.now()` reads even a millisecond below the deadline
   * when the fire callback lands (an NTP step back, or the climber editing the
   * device clock), the same beat is returned, and the fresh cycle id from the
   * fire waves the second advance straight through. Two climbs skipped, the wall
   * lit for the wrong one.
   */
  lastFiredDeadlineMs: number | null;
  /**
   * The workout stage pacing of the climb on the wall, or null when no stage
   * paces it. Written ONLY by `RestTimerPacingSync`; arm and disarm keep it,
   * because it describes the wall, not this arm.
   */
  stagePacing: RestTimerStagePacing | null;
  /**
   * The last tick this phone logged on a queue item while armed: its status and
   * that queue item. Cleared on arm, on disarm, and by a fire or a refilled queue
   * that waits for the next tick, so one tick never moves the wall twice.
   */
  lastTick: RestTimerLastTick | null;
};

const INITIAL_STATE: RestTimerState = {
  armed: false,
  armedForSessionId: null,
  anchorMs: null,
  isRunning: false,
  pausedElapsedSeconds: 0,
  cycleId: 0,
  lastTickAt: null,
  queueEnded: false,
  listEnded: false,
  lastFiredDeadlineMs: null,
  stagePacing: null,
  lastTick: null,
};

let state: RestTimerState = INITIAL_STATE;
const listeners = new Set<() => void>();

function setState(next: RestTimerState): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeRestTimer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRestTimerState(): RestTimerState {
  return state;
}

/**
 * Turn the timer on. `onTheMinute` anchors immediately so the cadence starts
 * ticking; `afterTick` has nothing to count from until the first tick lands, so
 * it stays anchorless and the pill shows the target instead of a false 0:00.
 */
export function armRestTimer(mode: RestTimerMode, nowMs: number, sessionId: string | null): void {
  setState({
    ...INITIAL_STATE,
    stagePacing: state.stagePacing,
    armed: true,
    armedForSessionId: sessionId,
    anchorMs: mode === 'onTheMinute' ? nowMs : null,
    isRunning: true,
    cycleId: state.cycleId + 1,
  });
}

export function disarmRestTimer(): void {
  // Keep the cycle counter climbing so any timeout scheduled against the old
  // cycle can never match after a re-arm.
  setState({ ...INITIAL_STATE, stagePacing: state.stagePacing, cycleId: state.cycleId + 1 });
}

/**
 * A tick landed. `afterTick` re-anchors on it — that is the whole mode.
 * `onTheMinute` keeps its own beat and only adopts the tick as a starting
 * anchor if it somehow has none.
 *
 * `tick` is how it went and the queue item it was logged on, from the tick path.
 * Left out (a tick read back from the session after a cold start), or naming no
 * queue item (a climb from a list or the logbook), the last one this phone logged
 * stands: such a tick says nothing about the climb on the wall, so it must not
 * cancel an advance that climb already earned.
 */
export function noteRestTimerTick(
  climbedAt: string,
  mode: RestTimerMode,
  nowMs: number,
  tick?: RestTimerLastTick,
): void {
  if (!state.armed) return;
  const tickMs = getRestTimerStartMs(climbedAt) ?? nowMs;
  const lastTick =
    tick && tick.queueItemUuid !== null ? { status: tick.status, queueItemUuid: tick.queueItemUuid } : state.lastTick;

  if (mode === 'onTheMinute') {
    setState({
      ...state,
      lastTickAt: climbedAt,
      lastTick,
      anchorMs: state.anchorMs ?? tickMs,
      // A tick means the climber is still going, so give the queue another look.
      // Deliberately NOT re-anchored — holding the beat is the whole mode — but
      // the cycle still has to roll when the latch clears, or the scheduler has
      // no change to react to and the timer stays stuck on a dead end that is
      // no longer dead.
      queueEnded: false,
      cycleId: state.queueEnded ? state.cycleId + 1 : state.cycleId,
    });
    return;
  }

  setState({
    ...state,
    lastTickAt: climbedAt,
    lastTick,
    anchorMs: tickMs,
    isRunning: true,
    pausedElapsedSeconds: 0,
    cycleId: state.cycleId + 1,
    // A fresh tick means the climber is still going; give the queue another look.
    queueEnded: false,
  });
}

export function pauseRestTimer(nowMs: number): void {
  if (!state.armed || !state.isRunning) return;
  const elapsedSeconds =
    state.anchorMs === null ? state.pausedElapsedSeconds : Math.max(0, Math.floor((nowMs - state.anchorMs) / 1000));
  setState({
    ...state,
    isRunning: false,
    pausedElapsedSeconds: elapsedSeconds,
    cycleId: state.cycleId + 1,
  });
}

export function resumeRestTimer(nowMs: number): void {
  if (!state.armed || state.isRunning) return;
  setState({
    ...state,
    isRunning: true,
    // Rebase the anchor so the frozen elapsed carries across the pause.
    anchorMs: nowMs - state.pausedElapsedSeconds * 1000,
    pausedElapsedSeconds: 0,
    cycleId: state.cycleId + 1,
  });
}

/**
 * Back to zero. Running restarts from now; paused clears the reference entirely
 * so the pill falls back to its "waiting for a tick" state.
 */
export function resetRestTimer(nowMs: number): void {
  if (!state.armed) return;
  setState({
    ...state,
    anchorMs: state.isRunning ? nowMs : null,
    pausedElapsedSeconds: 0,
    cycleId: state.cycleId + 1,
    queueEnded: false,
  });
}

/** A pre-session arm carrying into the session that just started. */
export function bindRestTimerToSession(sessionId: string): void {
  if (!state.armed || state.armedForSessionId === sessionId) return;
  setState({ ...state, armedForSessionId: sessionId });
}

/**
 * Where the anchor goes after an advance or a refilled queue
 * (`anchorAfterFire`): from now, kept, or cleared to wait for the next tick.
 */
export type RestTimerAnchorAfter = 'now' | 'keep' | 'clear';

function anchorFor(anchorAfter: RestTimerAnchorAfter, nowMs: number): number | null {
  if (anchorAfter === 'now') return nowMs;
  return anchorAfter === 'keep' ? state.anchorMs : null;
}

/**
 * The auto-advance fired. No-ops unless the caller is still on the cycle it
 * scheduled against, which is what stops a re-run effect or a remount from
 * advancing the queue twice for one interval.
 *
 * By default `afterTick` restarts the rest from the advance instant and
 * `onTheMinute` keeps its anchor, so the next deadline is simply the next beat.
 * `anchorAfter: 'clear'` (a tick or send rule) leaves no anchor and forgets the
 * tick, so the next climb rests only once it is logged.
 */
export function noteRestTimerAutoAdvanceFired(
  expectedCycleId: number,
  mode: RestTimerMode,
  nowMs: number,
  firedDeadlineMs: number,
  anchorAfter: RestTimerAnchorAfter = mode === 'onTheMinute' ? 'keep' : 'now',
): boolean {
  if (!state.armed || state.cycleId !== expectedCycleId) return false;
  setState({
    ...state,
    anchorMs: anchorFor(anchorAfter, nowMs),
    lastTick: anchorAfter === 'clear' ? null : state.lastTick,
    isRunning: true,
    pausedElapsedSeconds: 0,
    cycleId: state.cycleId + 1,
    lastFiredDeadlineMs: firedDeadlineMs,
  });
  return true;
}

/**
 * Nothing left to advance to. Stops the scheduler retrying every interval.
 * `listEnded` says it was the end of the list being walked, not of the queue.
 */
export function noteRestTimerQueueEnded({ listEnded = false }: { listEnded?: boolean } = {}): void {
  if (!state.armed || state.queueEnded) return;
  setState({ ...state, queueEnded: true, listEnded, cycleId: state.cycleId + 1 });
}

/**
 * The queue can advance again — someone added climbs, or switched board. Clears
 * the dead-end latch so the timer picks its beat back up without waiting for the
 * next tick, and rolls the cycle so the scheduler has a change to react to.
 * Under a tick or send rule (`anchorAfter: 'clear'`) it waits for the next tick
 * instead, and forgets the last one as the fire does: that tick's rest already
 * ran out at the dead end, and refilling a queue is not a reason to walk the
 * climber on. Kept, a Reset or a tick-less re-anchor would walk them on with it.
 */
export function clearRestTimerQueueEnded(
  nowMs: number,
  mode: RestTimerMode,
  anchorAfter: RestTimerAnchorAfter = mode === 'afterTick' ? 'now' : 'keep',
): void {
  if (!state.armed || !state.queueEnded) return;
  setState({
    ...state,
    queueEnded: false,
    // `afterTick`'s deadline is derived from the anchor, and by the time anyone
    // refills the queue that deadline is minutes in the past — it would never
    // come round again and the timer would stay dead. Restart the rest from the
    // moment the queue became advanceable. `onTheMinute` computes its deadline
    // forward from now, so its beat self-heals and the phase is worth keeping.
    anchorMs: anchorFor(anchorAfter, nowMs),
    lastTick: anchorAfter === 'clear' ? null : state.lastTick,
    pausedElapsedSeconds: 0,
    cycleId: state.cycleId + 1,
  });
}

/**
 * Returning from the background. Timers are suspended there and BLE writes need
 * the app active, so a deadline that passed while away was never actionable —
 * re-anchor and start a fresh cycle rather than firing a retroactive advance for
 * something the climber never saw.
 */
export function reanchorRestTimerAfterBackground(nowMs: number, deadlineMs: number | null): void {
  if (!state.armed || !state.isRunning || deadlineMs === null || deadlineMs > nowMs) return;
  setState({ ...state, anchorMs: nowMs, pausedElapsedSeconds: 0, cycleId: state.cycleId + 1 });
}

/**
 * The workout stage on the wall changed (`RestTimerPacingSync`). Stores it and,
 * while armed, applies the planned transition
 * (`planRestTimerPacingTransition`): `anchorNow` starts the beat now,
 * `waitForTick` clears the anchor so the rest starts at the next tick. Both
 * zero the paused elapsed, roll the cycle and keep `isRunning`,
 * `lastFiredDeadlineMs` and `lastTickAt`. A paused timer takes the transition
 * too: Resume rebases on the paused elapsed, so carrying it would land the new
 * stage mid-window (the first climb on the minute short of its interval, or the
 * last climb's rest carried onto the new one). Unarmed, only the pacing is
 * stored: arm sets its own anchor.
 */
export function applyRestTimerStagePacing(
  next: RestTimerStagePacing | null,
  nowMs: number,
  transition: RestTimerPacingTransition,
): void {
  if (sameStagePacing(state.stagePacing, next)) return;
  if (!state.armed || transition === 'none') {
    setState({ ...state, stagePacing: next });
    return;
  }
  setState({
    ...state,
    stagePacing: next,
    anchorMs: transition === 'anchorNow' ? nowMs : null,
    pausedElapsedSeconds: 0,
    cycleId: state.cycleId + 1,
  });
}

/** Test-only: drop every listener and return to the initial state. */
export function resetRestTimerStoreForTests(): void {
  state = INITIAL_STATE;
  listeners.clear();
}
