// What a gym timer should do when the session timer changes (#5397). Pure.
//
// A gym timer here is a dumb display: it can restart a count-up from zero and it
// can reset to zero, and it tells us nothing back. So the sink never mirrors the
// rest timer second by second; it diffs two snapshots and sends a command only
// when a new rest (or fixed window) started.
//
// The rules:
//   - the sink just mounted (prev null)           nothing, never restart on connect
//   - the timer was switched off                  reset
//   - a new rest started, and it is fresh          restart the count-up
//   - a pause, or a resume that carries its time  nothing (on the Rogue OK is a
//                                                 start/stop toggle, so pausing it
//                                                 would be a guess)
//
// "A new rest started" is one instant moving forward: the live clock's cycle
// start, or the last auto-advance. That one rule covers a tick, a Reset, an
// auto-advance (also when a tick or send rule clears the anchor), a fixed-window
// beat and a refilled queue.
//
// "Fresh" depends on what moved it, because the Rogue can only count from 0 now:
//   - a logged climb or an auto-advance (the store records both): up to a minute
//     old. A tick dates from when it was submitted and lands when the save
//     returns; an advance's deadline was already checked by the scheduler. A
//     tick backdated further, from an old session, never restarts the clock.
//   - anything else (a Reset, arming, a refilled queue, a fixed window's beat):
//     a few seconds. Those start a rest now, so an older one was seen late: a
//     beat whose wake was held while the phone was locked, or a window re-cut by
//     a new rest length. Restarting then would put the wall clock off the
//     window, so it waits for the next beat instead.

import { AUTO_ADVANCE_MAX_BACKDATE_MS, AUTO_ADVANCE_OVERDUE_GRACE_MS } from '../rest-timer-auto-advance';
import { isLiveSessionTimerSnapshot, type SessionTimerSnapshot } from './snapshot';

export type SessionTimerCommand =
  /** Zero the count-up and start it. `cycleStartMs` is the rest it follows. */
  | { kind: 'restartCountUp'; cycleStartMs: number }
  /** Back to zero. */
  | { kind: 'reset' };

/**
 * A resume rebases the anchor by the time already rested, so its cycle started
 * at least a second before now. A Reset while paused leaves nothing to carry, so
 * its resume starts a new rest at now. A tick logged while paused (afterTick
 * resumes on it) is told apart by its `lastTickAt`, not by this.
 */
export const SESSION_TIMER_RESUME_CARRY_MS = 1000;

/** How old a rest no logged climb or auto-advance explains can be and still restart the clock. */
export const SESSION_TIMER_RESTART_GRACE_MS = AUTO_ADVANCE_OVERDUE_GRACE_MS;

/** The instant the current rest started, as far as a restart is concerned. */
function restartMarkMs(snapshot: SessionTimerSnapshot): number | null {
  if (snapshot.status === 'off') return null;
  const cycleStartMs = isLiveSessionTimerSnapshot(snapshot) ? snapshot.cycleStartMs : null;
  if (cycleStartMs === null) return snapshot.lastAdvanceMs;
  if (snapshot.lastAdvanceMs === null) return cycleStartMs;
  return Math.max(cycleStartMs, snapshot.lastAdvanceMs);
}

function isFresh(markMs: number, nowMs: number): boolean {
  return nowMs - markMs <= AUTO_ADVANCE_MAX_BACKDATE_MS;
}

/**
 * Whether a logged climb or an auto-advance landed between the two snapshots and
 * can account for the new rest. A tick never moves a fixed window, so there a
 * new window start is the clock's, even with a tick in the same snapshot.
 */
function startedByRecordedEvent(prev: SessionTimerSnapshot, next: SessionTimerSnapshot): boolean {
  if (next.status === 'off') return false;
  const prevTickAt = prev.status === 'off' ? null : prev.lastTickAt;
  const prevAdvanceMs = prev.status === 'off' ? null : prev.lastAdvanceMs;
  const advanceFired = next.lastAdvanceMs !== null && next.lastAdvanceMs !== prevAdvanceMs;
  const tickLanded = next.lastTickAt !== null && next.lastTickAt !== prevTickAt;
  const isFixedWindow = isLiveSessionTimerSnapshot(next) && next.periodSeconds !== null;
  return advanceFired || (tickLanded && !isFixedWindow);
}

export function deriveSessionTimerCommands(
  prev: SessionTimerSnapshot | null,
  next: SessionTimerSnapshot,
  nowMs: number,
): SessionTimerCommand[] {
  if (prev === null) return [];

  if (next.status === 'off') return prev.status === 'off' ? [] : [{ kind: 'reset' }];

  const nextMarkMs = restartMarkMs(next);
  if (nextMarkMs === null) return [];

  const prevMarkMs = restartMarkMs(prev);
  if (prevMarkMs !== null && nextMarkMs <= prevMarkMs) return [];

  if (startedByRecordedEvent(prev, next)) {
    return isFresh(nextMarkMs, nowMs) ? [{ kind: 'restartCountUp', cycleStartMs: nextMarkMs }] : [];
  }

  // Resuming a pause keeps the rest already counted, and the gym clock kept
  // running through the pause, so there is nothing to restart.
  if (
    prev.status === 'paused' &&
    isLiveSessionTimerSnapshot(next) &&
    nowMs - nextMarkMs >= SESSION_TIMER_RESUME_CARRY_MS
  ) {
    return [];
  }

  if (nowMs - nextMarkMs > SESSION_TIMER_RESTART_GRACE_MS) return [];
  return [{ kind: 'restartCountUp', cycleStartMs: nextMarkMs }];
}

export type SessionTimerTickInput = {
  /**
   * Whether the session timer follows ticks itself: its snapshot is not 'off'.
   * Then a tick reaches the gym timer through the snapshot (or, in a fixed
   * window, deliberately does not), never through here.
   */
  restTimerArmed: boolean;
  /** When the climb was logged, or null when the timestamp did not parse. */
  climbedAtMs: number | null;
  nowMs: number;
};

/**
 * A logged climb with the rest timer off restarts the gym timer, as every tick
 * did before the session timer existed. A backdated one does not: logging last
 * week's session must not zero the clock on the wall.
 */
export function deriveSessionTimerTickCommand({
  restTimerArmed,
  climbedAtMs,
  nowMs,
}: SessionTimerTickInput): SessionTimerCommand | null {
  if (restTimerArmed) return null;
  // An unreadable timestamp counts as now, the way the rest timer's store reads it.
  const tickMs = climbedAtMs ?? nowMs;
  if (!isFresh(tickMs, nowMs)) return null;
  return { kind: 'restartCountUp', cycleStartMs: nowMs };
}
