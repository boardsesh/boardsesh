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
import { getAfterTickRestFloorMs, isTickFreshEnoughToArm } from './rest-timer-auto-advance';
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
   * lit for the wrong one. Under `afterTick` a running rest that began before
   * it counts from it instead (`floorRestTimerAnchorAtLastAdvance`). Cleared on
   * arm and disarm, so it only ever speaks for this arm.
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
   * that waits for the next tick, so one tick never moves the wall twice. A tick
   * on another climb never replaces one on the climb on the wall, and a tick
   * dated more than a minute before it landed never replaces any.
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
 * Where a tick starts a rest: at the tick, but never earlier than the rest
 * already running or the last advance, and never in the future.
 *
 * The scheduler's `afterTick` deadline is the anchor plus the rest. So a send
 * logged 2 s after an advance but dated 55 s back would, anchored at its own
 * time, put the next deadline 7 s out on a 60 s rest and move the wall again,
 * skipping the climb it just lit. Floored at the advance, the newly lit climb
 * gets its whole rest. (`floorRestTimerAnchorAtLastAdvance` backs this up for
 * the paths that reach such an anchor without a fresh tick, 3 s short of it.)
 * The cap at now keeps the anchor off the future: a fire can land a moment
 * before the deadline it records (a clock step back), and a tick can carry a
 * time from a clock running ahead of this phone's.
 */
function tickAnchorMs(tickStartMs: number, nowMs: number): number {
  const floorMs = Math.max(tickStartMs, state.anchorMs ?? tickStartMs, state.lastFiredDeadlineMs ?? tickStartMs);
  return Math.min(nowMs, floorMs);
}

/**
 * The last tick after this one lands. A tick naming no queue item, or left out,
 * keeps the last one. A tick on another queue item than the climb on the wall
 * (`stagePacing.queueItemUuid`) keeps the last one too when that one is the
 * wall's: a save started on the previous climb can finish after the advance,
 * even after the new climb's own tick, and taking its place would leave the new
 * climb never moving on under a tick or send rule until it was logged again.
 * With no stage naming the climb on the wall (the climber's own settings, which
 * advance on the deadline) every tick on a queue item replaces it, as before.
 */
function lastTickAfter(tick: RestTimerLastTick | undefined): RestTimerLastTick | null {
  if (!tick || tick.queueItemUuid === null) return state.lastTick;
  const onTheWall = state.stagePacing?.queueItemUuid ?? null;
  const wallTickStands =
    onTheWall !== null && tick.queueItemUuid !== onTheWall && state.lastTick?.queueItemUuid === onTheWall;
  return wallTickStands ? state.lastTick : { status: tick.status, queueItemUuid: tick.queueItemUuid };
}

/**
 * Where a tick dated more than `AUTO_ADVANCE_MAX_BACKDATE_MS` before it landed
 * starts a rest: yesterday's session logged with the date picker, not a climb
 * just done. On a running rest it goes through the floor, so it never rewinds
 * that rest. With none running (no anchor, or paused) it anchors at its own time,
 * as a tick always did before the floor: that rest ran out long ago, so the
 * scheduler reads its deadline as stale and schedules nothing. Floored instead,
 * it would start a rest at the last advance, a live deadline a send from
 * yesterday has no claim to.
 */
function historicalTickAnchorMs(tickStartMs: number, nowMs: number): number {
  return state.isRunning && state.anchorMs !== null ? tickAnchorMs(tickStartMs, nowMs) : tickStartMs;
}

/**
 * A tick landed. `afterTick` re-anchors on it — that is the whole mode.
 * `onTheMinute` keeps its own beat and only adopts the tick as a starting
 * anchor if it somehow has none. Either way the anchor goes through
 * `tickAnchorMs`, so a back-dated tick can never shorten a running rest or
 * reach back past the last advance. `lastTickAt` keeps the tick's own time.
 *
 * `tick` is how it went and the queue item it was logged on, from the tick path.
 * Left out (a tick read back from the session after a cold start), or naming no
 * queue item (a climb from a list or the logbook), the last one this phone logged
 * stands: such a tick says nothing about the climb on the wall, so it must not
 * cancel an advance that climb already earned. A late tick on the previous climb
 * never takes the place of one the climb on the wall already earned either
 * (`lastTickAfter`); it still goes through the anchor floor.
 *
 * A tick dated more than `AUTO_ADVANCE_MAX_BACKDATE_MS` before it landed is
 * history, judged on its own `climbedAt`, never the floored anchor: it never
 * earns an advance under a tick or send rule (`lastTick` stands), and it anchors
 * as `historicalTickAnchorMs` says. Without that, yesterday's send logged on a
 * workout climb just lit would be floored onto the advance, read as fresh, and
 * walk the wall on after the rest with the climb never climbed.
 */
export function noteRestTimerTick(
  climbedAt: string,
  mode: RestTimerMode,
  nowMs: number,
  tick?: RestTimerLastTick,
): void {
  if (!state.armed) return;
  const tickStartMs = getRestTimerStartMs(climbedAt) ?? nowMs;
  const isFresh = isTickFreshEnoughToArm(tickStartMs, nowMs);
  const lastTick = isFresh ? lastTickAfter(tick) : state.lastTick;
  const anchorFromTick = isFresh ? tickAnchorMs(tickStartMs, nowMs) : historicalTickAnchorMs(tickStartMs, nowMs);

  if (mode === 'onTheMinute') {
    setState({
      ...state,
      lastTickAt: climbedAt,
      lastTick,
      anchorMs: state.anchorMs ?? anchorFromTick,
      // A tick means the climber is still going, so give the queue another look.
      // Deliberately NOT re-anchored — holding the beat is the whole mode — but
      // the cycle still has to roll when the latch clears, or the scheduler has
      // no change to react to and the timer stays stuck on a dead end that is
      // no longer dead. A historical tick says nothing about the climber going
      // on now, so it leaves the latch alone.
      queueEnded: isFresh ? false : state.queueEnded,
      cycleId: state.queueEnded && isFresh ? state.cycleId + 1 : state.cycleId,
    });
    return;
  }

  if (!isFresh && !state.isRunning) {
    // A historical tick on a paused timer: the pause and the rest it froze
    // stand. Resuming here would lose the pause and count up from yesterday.
    setState({ ...state, lastTickAt: climbedAt });
    return;
  }

  setState({
    ...state,
    lastTickAt: climbedAt,
    lastTick,
    anchorMs: anchorFromTick,
    isRunning: true,
    pausedElapsedSeconds: 0,
    cycleId: state.cycleId + 1,
    // A fresh tick means the climber is still going; give the queue another
    // look. A historical one leaves the dead-end latch as it was.
    queueEnded: isFresh ? false : state.queueEnded,
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
 * A running `afterTick` rest that began before the last advance now counts from
 * it (`getAfterTickRestFloorMs`). The scheduler asks, because it knows the rest
 * length, the first time the rule applies; the store asks the same rule again,
 * so the anchor only ever moves later and only for a rest still running, never
 * one that ran out. Written down rather than worked out on every read: the rule
 * depends on the clock, and once the old anchor's own end went by it would let
 * go, so everything that reads the anchor (the pill, a pause) counts from this one.
 * From then on it behaves as a rest started at the advance, also under a later,
 * shorter rest length. Refused on any other cycle than the one it was asked for.
 */
export function floorRestTimerAnchorAtLastAdvance(
  expectedCycleId: number,
  mode: RestTimerMode,
  targetSeconds: number | null,
  nowMs: number,
): boolean {
  if (!state.armed || !state.isRunning || state.cycleId !== expectedCycleId) return false;
  const floorMs = getAfterTickRestFloorMs({
    mode,
    anchorMs: state.anchorMs,
    targetSeconds,
    nowMs,
    lastFiredDeadlineMs: state.lastFiredDeadlineMs,
  });
  if (floorMs === null) return false;
  setState({ ...state, anchorMs: floorMs, cycleId: state.cycleId + 1 });
  return true;
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
