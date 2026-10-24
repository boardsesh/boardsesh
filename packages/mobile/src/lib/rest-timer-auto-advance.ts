// Pure scheduling rules for the rest timer's auto-advance (#5378). Split out of
// the scheduler component so every guard is testable without mounting anything —
// and because the failure mode here is "the wall changes under a climber", which
// deserves tests that don't depend on a render tree.

import type { RestTimerMode } from './rest-timer';
import type { RestTimerState } from './rest-timer-store';

/**
 * The tick sheet lets a climber back-date a send. A tick older than this updates
 * the display but must not schedule an advance — otherwise logging yesterday's
 * session yanks the wall the instant you save it. The rest-timer store judges
 * every tick by it, on the tick's own time (`noteRestTimerTick`): such a tick
 * never earns an advance under a tick or send rule, and never rewinds a running
 * rest.
 */
export const AUTO_ADVANCE_MAX_BACKDATE_MS = 60_000;

export function isTickFreshEnoughToArm(tickMs: number | null, nowMs: number): boolean {
  if (tickMs === null) return false;
  return nowMs - tickMs <= AUTO_ADVANCE_MAX_BACKDATE_MS;
}

/**
 * How far past its deadline an advance may still fire. Anything later than this
 * means the JS timer queue was frozen — the app was backgrounded — and firing
 * would move the wall for an interval the climber never watched. Ordering-proof:
 * it does not depend on the AppState listener winning a race with the timer
 * queue on resume, which it does not reliably do.
 */
export const AUTO_ADVANCE_OVERDUE_GRACE_MS = 5_000;

type DeadlineInput = {
  mode: RestTimerMode;
  anchorMs: number | null;
  targetSeconds: number | null;
  nowMs: number;
  /**
   * {@link RestTimerState.lastFiredDeadlineMs}. `onTheMinute` never schedules at
   * or before it; `afterTick` never schedules a running rest earlier than one
   * whole rest after it, less {@link AUTO_ADVANCE_REST_FLOOR_SLACK_MS}.
   */
  lastFiredDeadlineMs?: number | null;
};

/**
 * How far before the last advance an `afterTick` rest may start and still run
 * from its own anchor (see {@link getAfterTickRestFloorMs}). A rest that starts
 * this close to an advance is an ordinary one: the fire re-anchors at its own
 * `nowMs`, which reads a moment before the deadline it records when the clock
 * steps back, and a crew clock rounds a pause to whole seconds and re-anchors an
 * early FIRE up to 2 s off the beat. Further back the rest is moved, never
 * refused, so the slack only sets how soon after an advance the next may come:
 * a whole rest less 3 s.
 */
export const AUTO_ADVANCE_REST_FLOOR_SLACK_MS = 3_000;

/**
 * Where a running `afterTick` rest counts from when its anchor is earlier than
 * the last advance less {@link AUTO_ADVANCE_REST_FLOOR_SLACK_MS}, or null when
 * its anchor stands.
 *
 * The tick floor in the store keeps a fresh tick off such an anchor, but other
 * paths still reach one. A send dated more than a minute back, logged with no
 * rest running (after a tick or send rule's advance, or after an on-the-minute
 * stage), anchors at its own time, and on a long enough rest that rest is still
 * running. A rest lengthened in the settings turns one that ran out long ago
 * into one that runs out seconds after the advance. Either would move the wall
 * again seconds after the last time. So the rest counts from the advance
 * instead, and the next advance waits a whole rest from it, less the slack.
 *
 * It only ever delays: a rest that has already run out (its own end at or
 * before `nowMs`) is left as it is, so its deadline stays past and nothing is
 * scheduled for it. Floored, a send from yesterday would get a live rest.
 *
 * The answer depends on `nowMs`, so the scheduler writes it into the store the
 * moment it first applies (`floorRestTimerAnchorAtLastAdvance`): from then on the
 * pill and a pause count from the floored anchor too, and the rest no longer
 * flips back to its own anchor once that one's end goes by.
 */
export function getAfterTickRestFloorMs({
  mode,
  anchorMs,
  targetSeconds,
  nowMs,
  lastFiredDeadlineMs = null,
}: DeadlineInput): number | null {
  if (mode !== 'afterTick' || anchorMs === null || lastFiredDeadlineMs === null) return null;
  if (targetSeconds === null || targetSeconds <= 0) return null;
  const floorMs = lastFiredDeadlineMs - AUTO_ADVANCE_REST_FLOOR_SLACK_MS;
  if (anchorMs >= floorMs) return null;
  if (anchorMs + targetSeconds * 1000 <= nowMs) return null;
  return floorMs;
}

/**
 * When the next advance is due, or null when nothing is scheduled.
 *
 * `afterTick` is one interval past the anchor, so it can already be in the past
 * for a back-dated tick: the store anchors one older than
 * `AUTO_ADVANCE_MAX_BACKDATE_MS` at its own time when no rest is running, and
 * the scheduler reads the deadline as stale (`isAutoAdvanceDeadlineStale`). A
 * running rest that began before the last advance counts from it instead
 * ({@link getAfterTickRestFloorMs}), so any `afterTick` deadline still ahead of
 * `nowMs` is at least `lastFiredDeadlineMs + targetSeconds * 1000 - 3 s`.
 *
 * `onTheMinute` returns the next beat STRICTLY after now, so arming exactly on a
 * boundary waits a full interval instead of firing on the spot.
 */
export function getAutoAdvanceDeadlineMs(input: DeadlineInput): number | null {
  const { mode, anchorMs, targetSeconds, nowMs, lastFiredDeadlineMs = null } = input;
  if (anchorMs === null || targetSeconds === null || targetSeconds <= 0) return null;
  const intervalMs = targetSeconds * 1000;

  if (mode === 'afterTick') return (getAfterTickRestFloorMs(input) ?? anchorMs) + intervalMs;

  const beatsElapsed = Math.floor((nowMs - anchorMs) / intervalMs);
  const deadlineMs = anchorMs + (beatsElapsed + 1) * intervalMs;

  // A beat we already fired can never come round again, even if the wall clock
  // steps backwards under us. Walk forward in whole intervals so the cadence's
  // phase is preserved exactly.
  if (lastFiredDeadlineMs !== null && deadlineMs <= lastFiredDeadlineMs) {
    const beatsBehind = Math.floor((lastFiredDeadlineMs - deadlineMs) / intervalMs) + 1;
    return deadlineMs + beatsBehind * intervalMs;
  }

  return deadlineMs;
}

/**
 * Whether a deadline is too far past to act on. See
 * {@link AUTO_ADVANCE_OVERDUE_GRACE_MS} — this is the background guard, and it
 * is checked at BOTH ends: when scheduling (so a back-dated tick never arms a
 * pointless timer or holds the screen awake) and inside the fire callback (so an
 * overdue timeout flushed on resume refuses to move the wall).
 */
export function isAutoAdvanceDeadlineStale(deadlineMs: number | null, nowMs: number): boolean {
  if (deadlineMs === null) return false;
  return nowMs - deadlineMs > AUTO_ADVANCE_OVERDUE_GRACE_MS;
}

type ScheduleInput = {
  state: RestTimerState;
  targetSeconds: number | null;
  autoAdvance: boolean;
  /**
   * Whether this device is the one driving the wall. In a crew session only the
   * driver's timer may move the shared queue — a passenger's timer still counts
   * for their own pacing. Same rule the Rogue hardware timer already follows.
   */
  canDriveWall: boolean;
};

export function shouldScheduleAutoAdvance({ state, targetSeconds, autoAdvance, canDriveWall }: ScheduleInput): boolean {
  if (!state.armed || !state.isRunning) return false;
  if (!autoAdvance || !canDriveWall) return false;
  if (targetSeconds === null || targetSeconds <= 0) return false;
  if (state.anchorMs === null) return false;
  // Already found the end of the queue; don't beat against it every interval.
  if (state.queueEnded) return false;
  return true;
}

type ElapsedInput = {
  mode: RestTimerMode;
  anchorMs: number | null;
  targetSeconds: number | null;
  nowMs: number;
  isRunning: boolean;
  pausedElapsedSeconds: number;
};

/**
 * What the pill shows. Both modes count UP, which is why they can share one
 * component: `afterTick` counts from your tick, `onTheMinute` counts from the
 * last beat, so the number always reads as "how long you have been resting".
 */
export function getRestTimerCycleElapsedSeconds({
  mode,
  anchorMs,
  targetSeconds,
  nowMs,
  isRunning,
  pausedElapsedSeconds,
}: ElapsedInput): number {
  if (!isRunning) return Math.max(0, pausedElapsedSeconds);
  if (anchorMs === null) return 0;

  const elapsedMs = Math.max(0, nowMs - anchorMs);
  if (mode === 'afterTick' || targetSeconds === null || targetSeconds <= 0) {
    return Math.floor(elapsedMs / 1000);
  }

  return Math.floor((elapsedMs % (targetSeconds * 1000)) / 1000);
}

// ---------------------------------------------------------------------------
// The final countdown (#5396): the last seconds of a rest, counted on screen and
// cued one per second, so the climber is on the holds when the rest runs out.
// The scheduler places the cues; the pill and hero clock draw the phase.

/**
 * How many seconds the final countdown runs. It scales with the rest: a 30 s
 * changeover needs a blink, a 3 min rest needs time to chalk up and step on.
 *
 *   rest up to 1:00       3 s
 *   1:01 to 2:59          4 s
 *   3:00 and longer       5 s
 *
 * Never the whole rest: at least one ordinary second runs before it. 0 when no
 * rest is set, so there is nothing to count down to.
 */
export function getRestTimerCountdownLeadSeconds(targetSeconds: number | null): number {
  if (targetSeconds === null || targetSeconds <= 0) return 0;
  const leadSeconds = targetSeconds <= 60 ? 3 : targetSeconds < 180 ? 4 : 5;
  return Math.max(0, Math.min(leadSeconds, Math.floor(targetSeconds) - 1));
}

export type RestTimerCountdownCueTime = {
  /** When the cue is due. */
  atMs: number;
  /** What the clock reads at that instant: 3, 2, 1. */
  secondsLeft: number;
};

/**
 * The countdown's cue instants before `targetAtMs`, earliest first: one per whole
 * second of the lead, landing exactly when the digits flip to that second (the
 * pill's ticker is aligned to the same anchor). The single warning, when
 * per-second cues are off, is the first of these.
 */
export function getRestTimerCountdownCueTimes(targetAtMs: number, leadSeconds: number): RestTimerCountdownCueTime[] {
  const cueTimes: RestTimerCountdownCueTime[] = [];
  for (let secondsLeft = leadSeconds; secondsLeft >= 1; secondsLeft -= 1) {
    cueTimes.push({ atMs: targetAtMs - secondsLeft * 1000, secondsLeft });
  }
  return cueTimes;
}

/**
 * A countdown cue (a tick or the warning) that lands later than this after its
 * instant says nothing. JS timers are frozen in the background and flush on
 * resume, and "2" buzzing a minute after the climber saw 0:02 is noise, not a
 * countdown.
 */
export const REST_TIMER_CUE_LATE_MS = 750;

export function isRestTimerCueLate(cueAtMs: number, nowMs: number): boolean {
  return nowMs - cueAtMs > REST_TIMER_CUE_LATE_MS;
}

/**
 * Whether the rest's end is too far past for its `reached` cue. The terminal cue
 * keeps the advance's tolerance ({@link AUTO_ADVANCE_OVERDUE_GRACE_MS}), not the
 * countdown's: a rest end up to that late still moves the wall with `advance`,
 * so a dead end that deadline finds, or a `reached` timeout a JS stall held up,
 * still says `reached`. Past it the rest gets neither, so every rest end has one
 * terminal cue or none.
 */
export function isRestTimerReachedCueLate(reachedAtMs: number, nowMs: number): boolean {
  return isAutoAdvanceDeadlineStale(reachedAtMs, nowMs);
}

/**
 * Whether the clock is in its final countdown: the last `leadSeconds` of the
 * rest, through 0:00. Past zero is the overrun, not the countdown.
 */
export function isRestTimerFinalCountdown(remainingSeconds: number | null, leadSeconds: number): boolean {
  if (remainingSeconds === null || leadSeconds <= 0) return false;
  return remainingSeconds >= 0 && remainingSeconds <= leadSeconds;
}

/**
 * How long until the clock's next whole second, counted from the anchor. The
 * pill's ticker waits exactly this long, so its digits flip on the same instants
 * the countdown cues land on instead of up to a second off. Always in (0, 1000].
 */
export function getMsUntilNextRestTimerSecond(anchorMs: number | null, nowMs: number): number {
  if (anchorMs === null) return 1000;
  const intoSecondMs = (((nowMs - anchorMs) % 1000) + 1000) % 1000;
  return 1000 - intoSecondMs;
}

type ReachedInput = {
  mode: RestTimerMode;
  anchorMs: number | null;
  targetSeconds: number | null;
  nowMs: number;
  /**
   * The latest instant that already had its terminal cue: the last `reached` the
   * scheduler played, or the beat an advance fired on. Nothing at or before it
   * is cued again.
   */
  handledThroughMs: number | null;
};

/**
 * When the rest runs out with nothing pending to move the wall (auto-advance off,
 * a crew passenger, a dead end), for the `reached` cue. Null when there is none
 * left to cue.
 *
 * `afterTick` has one such instant per anchor. `onTheMinute` has one per beat, so
 * the next beat comes round once this one has played. An instant that went
 * without a cue is returned until {@link isRestTimerReachedCueLate}, so a dead end
 * found on the deadline, or a second after it, still gets its cue.
 */
export function getRestTimerReachedAtMs({
  mode,
  anchorMs,
  targetSeconds,
  nowMs,
  handledThroughMs,
}: ReachedInput): number | null {
  if (anchorMs === null || targetSeconds === null || targetSeconds <= 0) return null;
  const isHandled = (instantMs: number) => handledThroughMs !== null && instantMs <= handledThroughMs;

  if (mode === 'afterTick') {
    const reachedAtMs = anchorMs + targetSeconds * 1000;
    return isHandled(reachedAtMs) || isRestTimerReachedCueLate(reachedAtMs, nowMs) ? null : reachedAtMs;
  }

  const intervalMs = targetSeconds * 1000;
  const beatsElapsed = Math.floor((nowMs - anchorMs) / intervalMs);
  const lastBeatMs = anchorMs + beatsElapsed * intervalMs;
  if (beatsElapsed >= 1 && !isHandled(lastBeatMs) && !isRestTimerReachedCueLate(lastBeatMs, nowMs)) return lastBeatMs;
  return getAutoAdvanceDeadlineMs({ mode, anchorMs, targetSeconds, nowMs, lastFiredDeadlineMs: handledThroughMs });
}
