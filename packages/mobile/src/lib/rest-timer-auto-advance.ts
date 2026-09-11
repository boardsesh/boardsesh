// Pure scheduling rules for the rest timer's auto-advance (#5378). Split out of
// the scheduler component so every guard is testable without mounting anything —
// and because the failure mode here is "the wall changes under a climber", which
// deserves tests that don't depend on a render tree.

import type { RestTimerMode } from './rest-timer';
import type { RestTimerState } from './rest-timer-store';

/**
 * The tick sheet lets a climber back-date a send. A tick older than this updates
 * the display but must not schedule an advance — otherwise logging yesterday's
 * session yanks the wall the instant you save it.
 */
export const AUTO_ADVANCE_MAX_BACKDATE_MS = 60_000;

/** Warn this long before the wall changes. */
export const AUTO_ADVANCE_WARNING_LEAD_MS = 3_000;

export function isTickFreshEnoughToArm(tickMs: number | null, nowMs: number): boolean {
  if (tickMs === null) return false;
  return nowMs - tickMs <= AUTO_ADVANCE_MAX_BACKDATE_MS;
}

type DeadlineInput = {
  mode: RestTimerMode;
  anchorMs: number | null;
  targetSeconds: number | null;
  nowMs: number;
};

/**
 * When the next advance is due, or null when nothing is scheduled.
 *
 * `afterTick` is one interval past the anchor, so it can already be in the past
 * for a back-dated tick — callers gate that with `isTickFreshEnoughToArm`.
 *
 * `onTheMinute` returns the next beat STRICTLY after now, so arming exactly on a
 * boundary waits a full interval instead of firing on the spot.
 */
export function getAutoAdvanceDeadlineMs({ mode, anchorMs, targetSeconds, nowMs }: DeadlineInput): number | null {
  if (anchorMs === null || targetSeconds === null || targetSeconds <= 0) return null;
  const intervalMs = targetSeconds * 1000;

  if (mode === 'afterTick') return anchorMs + intervalMs;

  const beatsElapsed = Math.floor((nowMs - anchorMs) / intervalMs);
  return anchorMs + (beatsElapsed + 1) * intervalMs;
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
