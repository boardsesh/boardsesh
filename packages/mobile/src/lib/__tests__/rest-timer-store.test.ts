import { beforeEach, describe, expect, it } from 'vitest';
import {
  armRestTimer,
  bindRestTimerToSession,
  disarmRestTimer,
  getRestTimerState,
  noteRestTimerAutoAdvanceFired,
  noteRestTimerQueueEnded,
  noteRestTimerTick,
  pauseRestTimer,
  reanchorRestTimerAfterBackground,
  resetRestTimer,
  resetRestTimerStoreForTests,
  resumeRestTimer,
  subscribeRestTimer,
} from '../rest-timer-store';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');
const tickAt = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

beforeEach(() => {
  resetRestTimerStoreForTests();
});

describe('arming', () => {
  it('anchors on-the-minute immediately so the cadence starts ticking', () => {
    armRestTimer('onTheMinute', T0, null);
    expect(getRestTimerState()).toMatchObject({ armed: true, anchorMs: T0, isRunning: true });
  });

  it('leaves after-tick anchorless until a tick lands, so the pill never shows a false zero', () => {
    armRestTimer('afterTick', T0, null);
    expect(getRestTimerState()).toMatchObject({ armed: true, anchorMs: null, isRunning: true });
  });

  it('records a pre-session arm as belonging to no session yet', () => {
    armRestTimer('afterTick', T0, null);
    expect(getRestTimerState().armedForSessionId).toBeNull();
    bindRestTimerToSession('session-1');
    expect(getRestTimerState().armedForSessionId).toBe('session-1');
  });

  it('notifies subscribers on arm and disarm', () => {
    let notifications = 0;
    const unsubscribe = subscribeRestTimer(() => {
      notifications += 1;
    });
    armRestTimer('afterTick', T0, null);
    disarmRestTimer();
    unsubscribe();
    armRestTimer('afterTick', T0, null);
    expect(notifications).toBe(2);
  });
});

describe('ticks', () => {
  it('re-anchors after-tick on every tick', () => {
    armRestTimer('afterTick', T0, null);
    noteRestTimerTick(tickAt(10), 'afterTick', T0 + 10_000);
    expect(getRestTimerState().anchorMs).toBe(T0 + 10_000);
    noteRestTimerTick(tickAt(95), 'afterTick', T0 + 95_000);
    expect(getRestTimerState().anchorMs).toBe(T0 + 95_000);
  });

  it('leaves the on-the-minute anchor alone so the beat holds against the clock', () => {
    armRestTimer('onTheMinute', T0, null);
    noteRestTimerTick(tickAt(20), 'onTheMinute', T0 + 20_000);
    expect(getRestTimerState().anchorMs).toBe(T0);
    expect(getRestTimerState().lastTickAt).toBe(tickAt(20));
  });

  it('adopts the tick as the on-the-minute anchor only when there is none', () => {
    armRestTimer('onTheMinute', T0, null);
    resetRestTimer(T0 + 5_000);
    pauseRestTimer(T0 + 6_000);
    resetRestTimer(T0 + 6_000);
    expect(getRestTimerState().anchorMs).toBeNull();
    noteRestTimerTick(tickAt(30), 'onTheMinute', T0 + 30_000);
    expect(getRestTimerState().anchorMs).toBe(T0 + 30_000);
  });

  it('ignores ticks entirely while disarmed', () => {
    noteRestTimerTick(tickAt(10), 'afterTick', T0 + 10_000);
    expect(getRestTimerState().anchorMs).toBeNull();
    expect(getRestTimerState().lastTickAt).toBeNull();
  });

  it('bumps the cycle so a pending advance for the old rest cannot fire', () => {
    armRestTimer('afterTick', T0, null);
    const beforeCycle = getRestTimerState().cycleId;
    noteRestTimerTick(tickAt(10), 'afterTick', T0 + 10_000);
    expect(getRestTimerState().cycleId).toBeGreaterThan(beforeCycle);
  });
});

describe('pause, resume and reset', () => {
  it('freezes elapsed at the press instant and carries it across the resume', () => {
    armRestTimer('afterTick', T0, null);
    noteRestTimerTick(tickAt(0), 'afterTick', T0);
    pauseRestTimer(T0 + 42_000);
    expect(getRestTimerState()).toMatchObject({ isRunning: false, pausedElapsedSeconds: 42 });

    resumeRestTimer(T0 + 100_000);
    expect(getRestTimerState()).toMatchObject({ isRunning: true, pausedElapsedSeconds: 0 });
    // Anchor rebased so the 42 frozen seconds are still on the clock.
    expect(getRestTimerState().anchorMs).toBe(T0 + 100_000 - 42_000);
  });

  it('restarts from now when reset while running', () => {
    armRestTimer('afterTick', T0, null);
    noteRestTimerTick(tickAt(0), 'afterTick', T0);
    resetRestTimer(T0 + 30_000);
    expect(getRestTimerState().anchorMs).toBe(T0 + 30_000);
  });

  it('clears the reference entirely when reset while paused', () => {
    armRestTimer('afterTick', T0, null);
    noteRestTimerTick(tickAt(0), 'afterTick', T0);
    pauseRestTimer(T0 + 30_000);
    resetRestTimer(T0 + 31_000);
    expect(getRestTimerState()).toMatchObject({ anchorMs: null, pausedElapsedSeconds: 0 });
  });

  it('does not pause an already paused timer', () => {
    armRestTimer('afterTick', T0, null);
    noteRestTimerTick(tickAt(0), 'afterTick', T0);
    pauseRestTimer(T0 + 10_000);
    pauseRestTimer(T0 + 90_000);
    expect(getRestTimerState().pausedElapsedSeconds).toBe(10);
  });
});

describe('auto-advance bookkeeping', () => {
  it('fires once and rolls the cycle', () => {
    armRestTimer('afterTick', T0, null);
    noteRestTimerTick(tickAt(0), 'afterTick', T0);
    const { cycleId } = getRestTimerState();

    expect(noteRestTimerAutoAdvanceFired(cycleId, 'afterTick', T0 + 60_000, T0 + 60_000)).toBe(true);
    expect(getRestTimerState().anchorMs).toBe(T0 + 60_000);
    expect(getRestTimerState().cycleId).not.toBe(cycleId);
  });

  it('refuses a stale cycle, so a re-run effect cannot skip two climbs', () => {
    armRestTimer('afterTick', T0, null);
    noteRestTimerTick(tickAt(0), 'afterTick', T0);
    const { cycleId } = getRestTimerState();

    expect(noteRestTimerAutoAdvanceFired(cycleId, 'afterTick', T0 + 60_000, T0 + 60_000)).toBe(true);
    expect(noteRestTimerAutoAdvanceFired(cycleId, 'afterTick', T0 + 60_001, T0 + 60_000)).toBe(false);
  });

  it('keeps the on-the-minute anchor when it fires, so the beat does not drift', () => {
    armRestTimer('onTheMinute', T0, null);
    const { cycleId } = getRestTimerState();
    noteRestTimerAutoAdvanceFired(cycleId, 'onTheMinute', T0 + 60_000, T0 + 60_000);
    expect(getRestTimerState().anchorMs).toBe(T0);
  });

  it('latches the end of the queue and clears it on the next tick', () => {
    armRestTimer('afterTick', T0, null);
    noteRestTimerQueueEnded();
    expect(getRestTimerState().queueEnded).toBe(true);
    noteRestTimerTick(tickAt(10), 'afterTick', T0 + 10_000);
    expect(getRestTimerState().queueEnded).toBe(false);
  });

  it('clears the dead-end latch on the next tick in on-the-minute mode too', () => {
    armRestTimer('onTheMinute', T0, null);
    noteRestTimerQueueEnded();
    const latchedCycle = getRestTimerState().cycleId;

    noteRestTimerTick(tickAt(10), 'onTheMinute', T0 + 10_000);
    expect(getRestTimerState().queueEnded).toBe(false);
    // The beat is held, but the cycle rolls so the scheduler has something to react to.
    expect(getRestTimerState().anchorMs).toBe(T0);
    expect(getRestTimerState().cycleId).toBeGreaterThan(latchedCycle);
  });

  it('does not roll the on-the-minute cycle for an ordinary tick', () => {
    armRestTimer('onTheMinute', T0, null);
    const { cycleId } = getRestTimerState();
    noteRestTimerTick(tickAt(10), 'onTheMinute', T0 + 10_000);
    expect(getRestTimerState().cycleId).toBe(cycleId);
  });
});

describe('backgrounding', () => {
  it('re-anchors rather than firing an advance the climber never saw', () => {
    armRestTimer('afterTick', T0, null);
    noteRestTimerTick(tickAt(0), 'afterTick', T0);
    reanchorRestTimerAfterBackground(T0 + 600_000, T0 + 60_000);
    expect(getRestTimerState().anchorMs).toBe(T0 + 600_000);
  });

  it('leaves a deadline that has not passed alone', () => {
    armRestTimer('afterTick', T0, null);
    noteRestTimerTick(tickAt(0), 'afterTick', T0);
    reanchorRestTimerAfterBackground(T0 + 30_000, T0 + 60_000);
    expect(getRestTimerState().anchorMs).toBe(T0);
  });
});

describe('disarming', () => {
  it('clears every runtime field', () => {
    armRestTimer('afterTick', T0, null);
    noteRestTimerTick(tickAt(0), 'afterTick', T0);
    bindRestTimerToSession('session-1');
    disarmRestTimer();
    expect(getRestTimerState()).toMatchObject({
      armed: false,
      armedForSessionId: null,
      anchorMs: null,
      isRunning: false,
      lastTickAt: null,
    });
  });

  it('keeps the cycle climbing so a timeout from before the disarm never matches', () => {
    armRestTimer('afterTick', T0, null);
    const { cycleId } = getRestTimerState();
    disarmRestTimer();
    armRestTimer('afterTick', T0 + 1000, null);
    expect(noteRestTimerAutoAdvanceFired(cycleId, 'afterTick', T0 + 2000, T0 + 2000)).toBe(false);
  });
});
