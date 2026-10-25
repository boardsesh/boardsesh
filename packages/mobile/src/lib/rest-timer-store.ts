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
// store is purely "what is the timer doing right now", and none of it is
// persisted — see `armed` below. The one way an arm comes back after a cold
// start is the crew's: a live crew clock is taken from the session's seed
// (`crew`, below), whoever set it, bounded by the live session.
//
// Two fields are context the timer runs in rather than its own state (#5380):
// `stagePacing`, the workout stage pacing of the climb on the wall, and
// `lastTick`, which climb the last tick was logged on and how it went. Readers
// merge the stage pacing with the settings through `useEffectiveRestPacing()`;
// the scheduler reads `lastTick` to decide whether a finished rest may move the
// wall under a tick or send rule (`restAdvanceAllowed`). Neither is persisted.
//
// The crew clock (#5382): in a session, the backend keeps one rest clock every
// member follows. `crew` holds it as this phone took it (lib/crew-rest-cadence.ts),
// and `adoptCrewCadence` writes its anchor, pause and last tick into the timer's
// own fields, so the pill and the scheduler read it unchanged. Every action this
// phone takes itself is announced to `subscribeLocalRestTimerActions`, which the
// crew publisher turns into `setSessionRestCadence` calls; taking a crew change
// announces nothing, so the two never echo each other.

import type { CrewRestCadence } from './crew-rest-cadence';
import { getRestTimerStartMs, type RestTimerMode } from './rest-timer';
import { getAfterTickRestFloorMs, isTickFreshEnoughToArm } from './rest-timer-auto-advance';
import {
  sameStagePacing,
  type CrewRestConfig,
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
  /**
   * The crew's shared clock for `armedForSessionId`, when this phone follows
   * one (#5382). Written only by `adoptCrewCadence` and `clearCrewCadence`; a
   * local arm or disarm drops it until the server's answer comes back. Its
   * config is null for a clock this app cannot run (never fired on).
   */
  crew: CrewRestCadence | null;
  /**
   * A change to the crew clock's length, cadence or auto-advance this phone
   * made from the timer's own controls (`editCrewRestPacing`) that the server
   * has not answered yet. Only the controls show it, so a second tap steps on
   * from the first; the timer keeps running on the crew's config until the
   * answer comes back. Cleared by that answer, or a crew config that matches it.
   */
  crewPacingDraft: CrewRestConfig | null;
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
   *
   * Only ever a real advance: the tick floor and the after-tick rest floor read
   * it as the wall's last move. A crew beat let go without one is
   * `crewBeatSkippedMs`.
   */
  lastFiredDeadlineMs: number | null;
  /**
   * The last beat of a crew's clock on the minute this phone let go without
   * moving the wall (`noteRestTimerCrewBeatSkipped`): its FIRE failed, came back
   * refused or too late, or the phone slept through it. The scheduler's
   * on-the-minute walk and its reached cue count it as handled, so they move on
   * to the next beat. Kept out of `lastFiredDeadlineMs`, since the server never
   * took it: read as an advance, a tick after the crew switched to after-tick
   * would floor its rest there and fall behind the crew's (Fable, #6757).
   */
  crewBeatSkippedMs: number | null;
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
  crew: null,
  crewPacingDraft: null,
  anchorMs: null,
  isRunning: false,
  pausedElapsedSeconds: 0,
  cycleId: 0,
  lastTickAt: null,
  queueEnded: false,
  listEnded: false,
  lastFiredDeadlineMs: null,
  crewBeatSkippedMs: null,
  stagePacing: null,
  lastTick: null,
};

let state: RestTimerState = INITIAL_STATE;
const listeners = new Set<() => void>();

/**
 * Something this phone did to its own timer, for the crew publisher to send on.
 * Each carries the session the timer was armed for at that moment, so an action
 * from a session the phone has since left is never sent into the new one.
 */
export type LocalRestTimerAction =
  | { type: 'arm'; sessionId: string | null }
  | { type: 'bound'; sessionId: string }
  | { type: 'disarm'; sessionId: string | null }
  | {
      type: 'tick';
      sessionId: string | null;
      tick: RestTimerLastTick | null;
      tickStartMs: number;
      /** False when the tick was kept out of `lastTick` (a late tick on another climb). */
      tickRecorded: boolean;
    }
  | { type: 'pause'; sessionId: string | null; pausedElapsedSeconds: number }
  | { type: 'resume'; sessionId: string | null }
  | { type: 'reset'; sessionId: string | null; isRunning: boolean }
  | { type: 'queueEndedCleared'; sessionId: string | null; anchorAfter: RestTimerAnchorAfter }
  /** This phone moved the wall itself (no crew clock, or a solo FIRE that got no answer). */
  | { type: 'fired'; sessionId: string | null; anchorAfter: RestTimerAnchorAfter }
  | { type: 'reanchored'; sessionId: string | null }
  /** `atMs`: the instant an `anchorNow` transition started the beat at, so the crew's NOW counts from it. */
  | { type: 'stagePacing'; sessionId: string | null; transition: RestTimerPacingTransition; atMs: number }
  /** The climber changed the crew clock from the timer's controls: `crewPacingDraft` holds what to send. */
  | { type: 'crewPacingEdited'; sessionId: string | null };

const localActionListeners = new Set<(action: LocalRestTimerAction) => void>();

function announce(action: LocalRestTimerAction): void {
  for (const listener of localActionListeners) listener(action);
}

/**
 * Every timer action this phone takes itself, after it applied. Never called
 * for a crew change taken from the server, so a publisher can send each one on
 * without an echo loop.
 */
export function subscribeLocalRestTimerActions(listener: (action: LocalRestTimerAction) => void): () => void {
  localActionListeners.add(listener);
  return () => {
    localActionListeners.delete(listener);
  };
}

/**
 * Reads the queue item on the wall now, for a crew clock with a tick or send
 * rule and no workout stage of its own (see `lastTickAfter`). Set by the crew
 * publisher, which can read the queue without subscribing to it.
 */
let readWallQueueItemUuid: () => string | null = () => null;

export function setRestTimerWallQueueItemReader(reader: (() => string | null) | null): void {
  readWallQueueItemUuid = reader ?? (() => null);
}

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
  announce({ type: 'arm', sessionId });
}

export function disarmRestTimer(): void {
  const sessionId = state.armedForSessionId;
  const wasArmed = state.armed;
  // Keep the cycle counter climbing so any timeout scheduled against the old
  // cycle can never match after a re-arm.
  setState({ ...INITIAL_STATE, stagePacing: state.stagePacing, cycleId: state.cycleId + 1 });
  if (wasArmed) announce({ type: 'disarm', sessionId });
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

/** Following a crew clock that moves on only after a tick (or a send) on the climb on the wall. */
function followsCrewTickRule(): boolean {
  const config = state.crew?.config;
  return config !== null && config !== undefined && config.advanceOn !== 'deadline';
}

/**
 * The last tick after this one lands. A tick naming no queue item, or left out,
 * keeps the last one. A tick on another queue item than the climb on the wall
 * (`stagePacing.queueItemUuid`) keeps the last one too when that one is the
 * wall's: a save started on the previous climb can finish after the advance,
 * even after the new climb's own tick, and taking its place would leave the new
 * climb never moving on under a tick or send rule until it was logged again.
 * Under a crew clock's tick or send rule with no stage of this phone's own, the
 * climb on the wall is the queue's current item (contracts §16, #6729). With
 * neither (the climber's own settings, or a crew clock that advances on the
 * deadline) every tick on a queue item replaces it, as before.
 */
function lastTickAfter(tick: RestTimerLastTick | undefined): RestTimerLastTick | null {
  if (!tick || tick.queueItemUuid === null) return state.lastTick;
  // A crew clock with a tick or send rule needs the same protection on a phone
  // that has no stage of its own: the climb on the wall is read from the queue.
  const onTheWall = state.stagePacing?.queueItemUuid ?? (followsCrewTickRule() ? readWallQueueItemUuid() : null);
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
  const tickAction: LocalRestTimerAction = {
    type: 'tick',
    sessionId: state.armedForSessionId,
    tick: tick ?? null,
    tickStartMs,
    tickRecorded: tick !== undefined && lastTick !== state.lastTick,
  };

  // Under a crew clock's tick or send rule the crew's rest belongs to the climb
  // on the wall: a tick kept out of the last tick (another climb, one from a
  // list, or one from history) never reaches the shared clock (see the crew
  // publisher), so it must not move this phone's rest either, or the two would
  // count different rests.
  if (followsCrewTickRule() && !tickAction.tickRecorded) {
    setState({ ...state, lastTickAt: climbedAt });
    announce(tickAction);
    return;
  }
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
    announce(tickAction);
    return;
  }

  if (!isFresh && !state.isRunning) {
    // A historical tick on a paused timer: the pause and the rest it froze
    // stand. Resuming here would lose the pause and count up from yesterday.
    // The crew's clock does the same with its TICK (#6754).
    setState({ ...state, lastTickAt: climbedAt });
    announce(tickAction);
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
  announce(tickAction);
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
  announce({ type: 'pause', sessionId: state.armedForSessionId, pausedElapsedSeconds: elapsedSeconds });
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
  announce({ type: 'resume', sessionId: state.armedForSessionId });
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
  announce({ type: 'reset', sessionId: state.armedForSessionId, isRunning: state.isRunning });
}

/** A pre-session arm carrying into the session that just started. */
export function bindRestTimerToSession(sessionId: string): void {
  if (!state.armed || state.armedForSessionId === sessionId) return;
  setState({ ...state, armedForSessionId: sessionId });
  announce({ type: 'bound', sessionId });
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
  announce({ type: 'fired', sessionId: state.armedForSessionId, anchorAfter });
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
  announce({ type: 'queueEndedCleared', sessionId: state.armedForSessionId, anchorAfter });
}

/**
 * Returning from the background. Timers are suspended there and BLE writes need
 * the app active, so a deadline that passed while away was never actionable —
 * re-anchor and start a fresh cycle rather than firing a retroactive advance for
 * something the climber never saw.
 */
export function reanchorRestTimerAfterBackground(nowMs: number, deadlineMs: number | null): void {
  if (!state.armed || !state.isRunning || deadlineMs === null || deadlineMs > nowMs) return;
  // A crew's fixed beat is the crew's: its next beat is still ahead, and moving
  // it here would put this phone out of step with everyone else (contracts §10).
  if (state.crew?.config?.mode === 'onTheMinute') return;
  setState({ ...state, anchorMs: nowMs, pausedElapsedSeconds: 0, cycleId: state.cycleId + 1 });
  announce({ type: 'reanchored', sessionId: state.armedForSessionId });
}

/**
 * A beat of a crew's clock on the minute went by without this phone moving the
 * wall: its FIRE failed, came back refused or too late, or its timeout ran with
 * the beat already stale. The crew's beat is never moved here (see above), so
 * nothing else in the store changes, and the scheduler, which works out the
 * next beat when it renders, would sit on the one that went. Marking it spent
 * walks the scheduler on to the next beat, never as an advance
 * (`crewBeatSkippedMs`). Announces nothing: the crew's clock did not change.
 */
export function noteRestTimerCrewBeatSkipped(beatMs: number): void {
  if (!state.armed || state.crew?.config?.mode !== 'onTheMinute') return;
  setState({
    ...state,
    crewBeatSkippedMs: Math.max(state.crewBeatSkippedMs ?? beatMs, beatMs),
    cycleId: state.cycleId + 1,
  });
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
    if (state.armed) announce({ type: 'stagePacing', sessionId: state.armedForSessionId, transition, atMs: nowMs });
    return;
  }
  setState({
    ...state,
    stagePacing: next,
    anchorMs: transition === 'anchorNow' ? nowMs : null,
    pausedElapsedSeconds: 0,
    cycleId: state.cycleId + 1,
  });
  announce({ type: 'stagePacing', sessionId: state.armedForSessionId, transition, atMs: nowMs });
}

function sameCrewTimerConfig(left: CrewRestCadence['config'], right: CrewRestCadence['config']): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.mode === right.mode &&
    left.targetSeconds === right.targetSeconds &&
    left.autoAdvance === right.autoAdvance &&
    left.advanceOn === right.advanceOn &&
    left.source === right.source &&
    left.setByParticipantId === right.setByParticipantId
  );
}

function sameLastTick(left: RestTimerLastTick | null, right: RestTimerLastTick | null): boolean {
  if (left === null || right === null) return left === right;
  return left.status === right.status && left.queueItemUuid === right.queueItemUuid;
}

/** The five fields a CONFIGURE carries, compared one by one. */
function sameCrewPacingFields(
  left: Pick<CrewRestConfig, 'mode' | 'targetSeconds' | 'autoAdvance' | 'advanceOn' | 'source'>,
  right: Pick<CrewRestConfig, 'mode' | 'targetSeconds' | 'autoAdvance' | 'advanceOn' | 'source'>,
): boolean {
  return (
    left.mode === right.mode &&
    left.targetSeconds === right.targetSeconds &&
    left.autoAdvance === right.autoAdvance &&
    left.advanceOn === right.advanceOn &&
    left.source === right.source
  );
}

/**
 * The climber changed the crew clock's length, cadence or auto-advance from the
 * timer's controls (lib/crew-rest-cadence.ts `editCrewRestPacing` builds
 * `config`). Held as the draft the controls show, and announced so the crew
 * publisher sends it as a CONFIGURE. Only while this phone follows a crew clock
 * it can run. The timer itself waits for the server's answer.
 */
export function setCrewRestPacingDraft(config: CrewRestConfig): boolean {
  const crew = state.crew;
  if (!state.armed || crew === null || crew.config === null) return false;
  setState({ ...state, crewPacingDraft: config });
  announce({ type: 'crewPacingEdited', sessionId: crew.sessionId });
  return true;
}

/**
 * The server answered (or failed to answer) a CONFIGURE sent for `sent`. The
 * draft goes unless the climber has changed it again since, in which case the
 * newer one is still on its way.
 */
export function settleCrewRestPacingDraft(
  sent: Pick<CrewRestConfig, 'mode' | 'targetSeconds' | 'autoAdvance' | 'advanceOn' | 'source'>,
): void {
  const draft = state.crewPacingDraft;
  if (draft === null || !sameCrewPacingFields(draft, sent)) return;
  setState({ ...state, crewPacingDraft: null });
}

/** The publisher for the draft's session went: nothing will send it. */
export function dropCrewRestPacingDraft(sessionId: string): void {
  if (state.crewPacingDraft === null || state.crew?.sessionId !== sessionId) return;
  setState({ ...state, crewPacingDraft: null });
}

/**
 * How far a better clock-offset estimate has to move a crew instant the server
 * did not move before this phone takes the new conversion. Below it the instant
 * stays put, so the deadline does not jitter with every clock sample.
 */
export const CREW_RECONVERT_THRESHOLD_MS = 250;

/** Whether a fresh conversion of a server instant moved it past the threshold from the one held. */
export function crewConversionMoved(heldMs: number | null, freshMs: number | null): boolean {
  if (heldMs === null || freshMs === null) return heldMs !== freshMs;
  return Math.abs(freshMs - heldMs) > CREW_RECONVERT_THRESHOLD_MS;
}

/**
 * Follow the crew clock (lib/crew-rest-cadence.ts decides when). The timer is
 * armed for the crew's session and runs on its anchor, pause and last tick.
 *
 * What the SERVER changed is what moves: when its anchor, pause and running
 * state are the ones already held, this phone's own fields stay as they are,
 * so an action this phone just took (a reset whose echo is still on its way)
 * is not undone by an unrelated change. The cycle rolls only when something
 * the scheduler reads changed. The last advance is the later of the two
 * clocks', so neither phone's beat can fire twice.
 *
 * An instant the server did not move keeps the conversion already held, unless
 * the clock offset estimate moved it by more than CREW_RECONVERT_THRESHOLD_MS
 * and this phone has no action of its own waiting. A clock is converted when it
 * is taken, and on a cold start the first estimate can be seconds out (a lower
 * bound, read late); on the minute the server never moves the anchor, so that
 * error would otherwise last the whole block.
 *
 * A clock this app cannot run (config null) is only held: the timer keeps its
 * own state and the scheduler refuses to fire while it is there.
 */
export function adoptCrewCadence(
  crew: CrewRestCadence,
  { replaceLocal = false }: { replaceLocal?: boolean } = {},
): void {
  // A snapshot (the subscribe seed) is the whole truth: it replaces whatever
  // this phone did meanwhile, including an action whose send never landed.
  const previous = !replaceLocal && state.crew !== null && state.crew.sessionId === crew.sessionId ? state.crew : null;
  const config = previous !== null && sameCrewTimerConfig(previous.config, crew.config) ? previous.config : crew.config;
  // A draft the crew's config now matches has landed; one for another session never will.
  const crewPacingDraft =
    state.crewPacingDraft === null ||
    previous === null ||
    (config !== null && sameCrewPacingFields(state.crewPacingDraft, config))
      ? null
      : state.crewPacingDraft;
  if (config === null) {
    setState({ ...state, crew: { ...crew, config }, crewPacingDraft: null, cycleId: state.cycleId + 1 });
    return;
  }
  const serverClockHeld =
    previous !== null &&
    previous.config !== null &&
    previous.anchorServerMs === crew.anchorServerMs &&
    previous.isRunning === crew.isRunning &&
    previous.pausedElapsedSeconds === crew.pausedElapsedSeconds;
  const serverTickHeld = previous !== null && sameLastTick(previous.lastTick, crew.lastTick);
  const lastFiredHeld = previous !== null && previous.lastFiredBeatServerMs === crew.lastFiredBeatServerMs;
  // The crew's instants on this phone's clock, as held unless the server or the offset moved them.
  const crewAnchorMs =
    serverClockHeld && !crewConversionMoved(previous.anchorMs, crew.anchorMs) ? previous.anchorMs : crew.anchorMs;
  const crewLastFiredBeatMs =
    lastFiredHeld && !crewConversionMoved(previous.lastFiredBeatMs, crew.lastFiredBeatMs)
      ? previous.lastFiredBeatMs
      : crew.lastFiredBeatMs;
  // The server's clock is the one held and this phone's own fields still match
  // it: no action of this phone's is waiting for its echo.
  const followsHeldClock =
    serverClockHeld &&
    state.anchorMs === previous.anchorMs &&
    state.isRunning === previous.isRunning &&
    state.pausedElapsedSeconds === previous.pausedElapsedSeconds;
  const keepsOwnClock = serverClockHeld && state.armed && !followsHeldClock;
  const anchorMs = keepsOwnClock ? state.anchorMs : crewAnchorMs;
  const isRunning = keepsOwnClock ? state.isRunning : crew.isRunning;
  const pausedElapsedSeconds = keepsOwnClock ? state.pausedElapsedSeconds : crew.pausedElapsedSeconds;
  const lastTick = serverTickHeld && state.armed ? state.lastTick : crew.lastTick;
  const lastFiredDeadlineMs =
    crewLastFiredBeatMs === null
      ? state.lastFiredDeadlineMs
      : lastFiredHeld && state.lastFiredDeadlineMs === previous.lastFiredBeatMs
        ? // Nothing fired here since: follow the conversion.
          crewLastFiredBeatMs
        : Math.max(state.lastFiredDeadlineMs ?? crewLastFiredBeatMs, crewLastFiredBeatMs);
  const timerChanged =
    !state.armed ||
    state.armedForSessionId !== crew.sessionId ||
    anchorMs !== state.anchorMs ||
    isRunning !== state.isRunning ||
    pausedElapsedSeconds !== state.pausedElapsedSeconds ||
    lastFiredDeadlineMs !== state.lastFiredDeadlineMs ||
    !sameCrewTimerConfig(state.crew?.config ?? null, config);
  setState({
    ...state,
    armed: true,
    armedForSessionId: crew.sessionId,
    crew: { ...crew, config, anchorMs: crewAnchorMs, lastFiredBeatMs: crewLastFiredBeatMs },
    crewPacingDraft,
    anchorMs,
    isRunning,
    pausedElapsedSeconds,
    lastTick,
    lastFiredDeadlineMs,
    // A beat let go only means something on the minute.
    crewBeatSkippedMs: config.mode === 'onTheMinute' ? state.crewBeatSkippedMs : null,
    // The crew clock restarting is a reason to look at the queue again, as a tick is.
    queueEnded: anchorMs !== state.anchorMs ? false : state.queueEnded,
    cycleId: timerChanged ? state.cycleId + 1 : state.cycleId,
  });
}

/**
 * The crew turned its clock off. A followed clock turns this phone's timer off
 * with it; an unsupported one was never running it, so only the hold goes.
 */
export function clearCrewCadence(): void {
  if (state.crew === null) return;
  if (state.crew.config === null) {
    setState({ ...state, crew: null, cycleId: state.cycleId + 1 });
    return;
  }
  setState({ ...INITIAL_STATE, stagePacing: state.stagePacing, cycleId: state.cycleId + 1 });
}

/** Test-only: drop every listener and return to the initial state. */
export function resetRestTimerStoreForTests(): void {
  state = INITIAL_STATE;
  listeners.clear();
  localActionListeners.clear();
  readWallQueueItemUuid = () => null;
}
