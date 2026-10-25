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
//   - a tick this phone did not just save         nothing (the session's last
//                                                 tick read back on arming or a
//                                                 cold start)
//
// "A new rest started" is one instant moving forward: the live clock's cycle
// start, or the last auto-advance. That one rule covers a tick, a Reset, an
// auto-advance (also when a tick or send rule clears the anchor), a fixed-window
// beat and a refilled queue.
//
// "Fresh" depends on what moved it, because the Rogue can only count from 0 now:
//   - a climb this phone just saved or an auto-advance (the store records both):
//     up to a minute old. A tick dates from when it was submitted and lands when the save
//     returns; an advance's deadline was already checked by the scheduler. A
//     tick backdated further, from an old session, never restarts the clock. In
//     a fixed window only the tick that started it counts, when the timer was
//     waiting for one.
//   - anything else (a Reset, arming, a refilled queue, a fixed window's beat):
//     a few seconds. Those start a rest now, so an older one was seen late: a
//     beat whose wake was held while the phone was locked, or a window re-cut by
//     a new rest length. Restarting then would put the wall clock off the
//     window, so it waits for the next beat instead.

import { getRestTimerStartMs } from '../rest-timer';
import { AUTO_ADVANCE_MAX_BACKDATE_MS, AUTO_ADVANCE_OVERDUE_GRACE_MS } from '../rest-timer-auto-advance';
import { isLiveSessionTimerSnapshot, type SessionTimerLiveSnapshot, type SessionTimerSnapshot } from './snapshot';

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
 * Whether the tick that just landed started the fixed window `next` shows. The
 * timer was waiting for a tick (a stage change, or a tick or send rule's
 * advance, left no anchor), so the store anchored the window on it, and this is
 * still that first window. A tick inside a running window never moves it, and
 * neither does one backdated past the window it would have started.
 */
function tickStartedFixedWindow(
  prev: SessionTimerSnapshot,
  next: SessionTimerLiveSnapshot,
  periodSeconds: number,
): boolean {
  if (prev.status !== 'waiting') return false;
  const tickMs = getRestTimerStartMs(next.lastTickAt);
  if (tickMs === null) return false;
  return next.cycleStartMs >= tickMs && next.cycleStartMs < tickMs + periodSeconds * 1000;
}

/**
 * What moved the rest forward between the two snapshots:
 *   advance       an auto-advance fired
 *   savedTick     the climb this phone just saved started it (the tick bus
 *                 stamped it, see `savedTickAt`)
 *   restoredTick  a tick this phone did not just save started it: the session's
 *                 last tick, read back when the timer is armed or after a cold
 *                 start
 *   clock         anything else: a Reset, arming, a refilled queue, a beat
 * In a fixed window a tick only starts the rest when it started the window; any
 * other new window start is the clock's, even with a tick in the same snapshot.
 */
type NewRestCause = 'advance' | 'savedTick' | 'restoredTick' | 'clock';

function newRestCause(
  prev: SessionTimerSnapshot,
  next: Exclude<SessionTimerSnapshot, { status: 'off' }>,
  savedTickAt: string | null,
): NewRestCause {
  const prevTickAt = prev.status === 'off' ? null : prev.lastTickAt;
  const prevAdvanceMs = prev.status === 'off' ? null : prev.lastAdvanceMs;
  if (next.lastAdvanceMs !== null && next.lastAdvanceMs !== prevAdvanceMs) return 'advance';
  if (next.lastTickAt === null || next.lastTickAt === prevTickAt) return 'clock';
  const tickStartedRest =
    !isLiveSessionTimerSnapshot(next) ||
    next.periodSeconds === null ||
    tickStartedFixedWindow(prev, next, next.periodSeconds);
  if (!tickStartedRest) return 'clock';
  return next.lastTickAt === savedTickAt ? 'savedTick' : 'restoredTick';
}

/**
 * The commands for the change from `prev` to `next`. `savedTickAt` is the
 * `lastTickAt` of the climb this phone just saved: the tick bus hands it to the
 * sink just before the rest timer hears of the climb. Null when none is waiting.
 * A new `lastTickAt` without it was read back, not logged now.
 */
export function deriveSessionTimerCommands(
  prev: SessionTimerSnapshot | null,
  next: SessionTimerSnapshot,
  nowMs: number,
  savedTickAt: string | null,
): SessionTimerCommand[] {
  if (prev === null) return [];

  if (next.status === 'off') return prev.status === 'off' ? [] : [{ kind: 'reset' }];

  const nextMarkMs = restartMarkMs(next);
  if (nextMarkMs === null) return [];

  const prevMarkMs = restartMarkMs(prev);
  if (prevMarkMs !== null && nextMarkMs <= prevMarkMs) return [];

  const cause = newRestCause(prev, next, savedTickAt);
  // No climb was logged on this phone just now. The gym clock already counted
  // that one (its own tick restarted it then, with the rest timer off), or never
  // heard of it (logged elsewhere), so zeroing it now would cut a running rest.
  if (cause === 'restoredTick') return [];
  if (cause !== 'clock') {
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
   * Whether the session timer follows ticks itself: `isArmedForThisPhone`, the
   * rule behind the snapshot's 'off', read from the store as the tick lands.
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
