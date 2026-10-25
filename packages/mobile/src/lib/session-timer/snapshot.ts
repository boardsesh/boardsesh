// The session timer as one platform-neutral value (#5397). Pure: no React, no
// I/O, `nowMs` passed in.
//
// The rest timer's store says what the timer is doing; this says what a display
// of it should show right now, in the same statuses the Lock Screen payload uses
// (#6513) plus 'off'. A gym timer, a widget or any later surface reads this
// instead of re-deriving the pill's rules, so they can never disagree about
// which phase the timer is in or when its window ends.
//
// The phase precedence is the pill's: off, then paused, then waiting for a tick,
// then a live clock (queue ended, count-up without a rest length, or running).

import type { RestTimerMode } from '../rest-timer';
import { getAutoAdvanceDeadlineMs, getRestTimerCycleElapsedSeconds } from '../rest-timer-auto-advance';
import type { RestTimerState } from '../rest-timer-store';

type SnapshotBase = {
  /** The rest length, or null when none is set. */
  targetSeconds: number | null;
  /**
   * The deadline the last auto-advance fired on. A gym timer restarts on an
   * advance even when the anchor clears under a tick or send rule, so the
   * advance has to be visible without a live clock.
   */
  lastAdvanceMs: number | null;
  /**
   * The last logged climb's timestamp, as the store keeps it. A gym timer reads
   * a change as "a climb was just logged", which is how it tells a tick that
   * resumes a paused rest from a plain resume, and how it lets a tick that took
   * a while to save still restart the clock.
   */
  lastTickAt: string | null;
};

export type SessionTimerLiveStatus = 'running' | 'countUp' | 'queueEnded';

export type SessionTimerSnapshot =
  | { status: 'off' }
  | (SnapshotBase & { status: 'waiting' })
  | (SnapshotBase & { status: 'paused'; frozenElapsedSeconds: number })
  | (SnapshotBase & {
      status: SessionTimerLiveStatus;
      /** When the current rest (or fixed window) started counting. */
      cycleStartMs: number;
      /** When it ends, or null without a rest length. */
      deadlineMs: number | null;
      /** The fixed window's length for `onTheMinute`, else null. */
      periodSeconds: number | null;
    });

export type SessionTimerLiveSnapshot = Extract<SessionTimerSnapshot, { status: SessionTimerLiveStatus }>;

export type SessionTimerSnapshotInput = {
  state: RestTimerState;
  pacing: { targetSeconds: number | null; mode: RestTimerMode };
  /** The session this phone is in, or null when solo or before one starts. */
  sessionId: string | null;
  nowMs: number;
};

const OFF: SessionTimerSnapshot = { status: 'off' };

export function isLiveSessionTimerSnapshot(snapshot: SessionTimerSnapshot): snapshot is SessionTimerLiveSnapshot {
  return snapshot.status === 'running' || snapshot.status === 'countUp' || snapshot.status === 'queueEnded';
}

/**
 * Whether the rest timer is on for the session this phone is in: the one rule
 * behind the snapshot's 'off'. A null arm is a pre-session arm (or a solo
 * climber's, who never gets a session). Any other id belongs to a session this
 * phone has left, which RestTimerSessionSync is about to disarm.
 */
export function isArmedForThisPhone(
  state: Pick<RestTimerState, 'armed' | 'armedForSessionId'>,
  sessionId: string | null,
): boolean {
  return state.armed && (state.armedForSessionId === null || state.armedForSessionId === sessionId);
}

export function buildSessionTimerSnapshot({
  state,
  pacing,
  sessionId,
  nowMs,
}: SessionTimerSnapshotInput): SessionTimerSnapshot {
  if (!isArmedForThisPhone(state, sessionId)) return OFF;

  const { anchorMs, isRunning, pausedElapsedSeconds, queueEnded, lastFiredDeadlineMs, lastTickAt } = state;
  const { mode } = pacing;
  const targetSeconds = pacing.targetSeconds !== null && pacing.targetSeconds > 0 ? pacing.targetSeconds : null;
  const base: SnapshotBase = { targetSeconds, lastAdvanceMs: lastFiredDeadlineMs, lastTickAt };

  if (!isRunning) {
    return {
      ...base,
      status: 'paused',
      frozenElapsedSeconds: getRestTimerCycleElapsedSeconds({
        mode,
        anchorMs,
        targetSeconds,
        nowMs,
        isRunning,
        pausedElapsedSeconds,
      }),
    };
  }

  if (anchorMs === null) return { ...base, status: 'waiting' };

  if (targetSeconds === null) {
    return {
      ...base,
      status: queueEnded ? 'queueEnded' : 'countUp',
      cycleStartMs: anchorMs,
      deadlineMs: null,
      periodSeconds: null,
    };
  }

  const status = queueEnded ? 'queueEnded' : 'running';
  if (mode === 'onTheMinute') {
    // The beat the auto-advance scheduler counts to, so this and the scheduler
    // agree on when the window ends.
    const deadlineMs =
      getAutoAdvanceDeadlineMs({ mode, anchorMs, targetSeconds, nowMs, lastFiredDeadlineMs }) ??
      anchorMs + targetSeconds * 1000;
    return {
      ...base,
      status,
      cycleStartMs: deadlineMs - targetSeconds * 1000,
      deadlineMs,
      periodSeconds: targetSeconds,
    };
  }

  return {
    ...base,
    status,
    cycleStartMs: anchorMs,
    deadlineMs: anchorMs + targetSeconds * 1000,
    periodSeconds: null,
  };
}

/**
 * When the snapshot changes by itself, with no store write: a fixed window
 * rolling over to the next one. Null for everything else, whose next change
 * comes from the store (a tick, a fire, a pause).
 */
export function getSessionTimerWakeMs(snapshot: SessionTimerSnapshot): number | null {
  if (!isLiveSessionTimerSnapshot(snapshot)) return null;
  if (snapshot.periodSeconds === null) return null;
  return snapshot.deadlineMs;
}
