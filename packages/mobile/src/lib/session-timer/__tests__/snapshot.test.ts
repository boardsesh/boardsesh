// The session timer's one value. Driven through the real rest-timer store, so
// each case is a state the app can actually reach.
import { beforeEach, describe, expect, it } from 'vitest';
import type { RestTimerMode } from '../../rest-timer';
import {
  armRestTimer,
  disarmRestTimer,
  getRestTimerState,
  noteRestTimerAutoAdvanceFired,
  noteRestTimerQueueEnded,
  noteRestTimerTick,
  pauseRestTimer,
  resetRestTimerStoreForTests,
} from '../../rest-timer-store';
import {
  buildSessionTimerSnapshot,
  getSessionTimerWakeMs,
  isArmedForThisPhone,
  type SessionTimerSnapshot,
} from '../snapshot';

const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const at = (seconds: number) => T0 + seconds * 1000;
const iso = (seconds: number) => new Date(at(seconds)).toISOString();

function snapshotAt(
  seconds: number,
  {
    targetSeconds = 60,
    mode = 'afterTick',
    sessionId = null,
  }: Partial<{
    targetSeconds: number | null;
    mode: RestTimerMode;
    sessionId: string | null;
  }> = {},
): SessionTimerSnapshot {
  return buildSessionTimerSnapshot({
    state: getRestTimerState(),
    pacing: { targetSeconds, mode },
    sessionId,
    nowMs: at(seconds),
  });
}

beforeEach(() => {
  resetRestTimerStoreForTests();
});

describe('off', () => {
  it('is off until the timer is armed', () => {
    expect(snapshotAt(0)).toEqual({ status: 'off' });
  });

  it('is off once disarmed', () => {
    armRestTimer('afterTick', at(0), null);
    disarmRestTimer();
    expect(snapshotAt(1)).toEqual({ status: 'off' });
  });

  it('is off for a timer armed for a session this phone has left', () => {
    armRestTimer('afterTick', at(0), 'session-a');
    expect(snapshotAt(1, { sessionId: 'session-b' })).toEqual({ status: 'off' });
    expect(snapshotAt(1, { sessionId: null })).toEqual({ status: 'off' });
  });

  it('follows a pre-session arm, and a solo climber with no session at all', () => {
    armRestTimer('afterTick', at(0), null);
    expect(snapshotAt(1, { sessionId: 'session-a' }).status).toBe('waiting');
    expect(snapshotAt(1, { sessionId: null }).status).toBe('waiting');
  });

  it('answers isArmedForThisPhone exactly when the snapshot is not off', () => {
    const cases: Array<{ arm: () => void; sessionId: string | null }> = [
      { arm: () => {}, sessionId: null },
      { arm: () => armRestTimer('afterTick', at(0), null), sessionId: null },
      { arm: () => armRestTimer('afterTick', at(0), null), sessionId: 'session-a' },
      { arm: () => armRestTimer('afterTick', at(0), 'session-a'), sessionId: 'session-a' },
      { arm: () => armRestTimer('afterTick', at(0), 'session-a'), sessionId: 'session-b' },
      { arm: () => armRestTimer('afterTick', at(0), 'session-a'), sessionId: null },
    ];
    for (const { arm, sessionId } of cases) {
      resetRestTimerStoreForTests();
      arm();
      expect(isArmedForThisPhone(getRestTimerState(), sessionId)).toBe(snapshotAt(1, { sessionId }).status !== 'off');
    }
  });
});

describe('afterTick', () => {
  it('waits for the first tick with the rest length and no clock', () => {
    armRestTimer('afterTick', at(0), null);
    expect(snapshotAt(5)).toEqual({ status: 'waiting', targetSeconds: 60, lastAdvanceMs: null, lastTickAt: null });
  });

  it('runs from the tick to one rest later', () => {
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    expect(snapshotAt(30)).toEqual({
      status: 'running',
      targetSeconds: 60,
      lastAdvanceMs: null,
      lastTickAt: iso(10),
      cycleStartMs: at(10),
      deadlineMs: at(70),
      periodSeconds: null,
    });
  });

  it('counts up with no deadline when no rest length is set', () => {
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    expect(snapshotAt(30, { targetSeconds: null })).toMatchObject({
      status: 'countUp',
      targetSeconds: null,
      cycleStartMs: at(10),
      deadlineMs: null,
      periodSeconds: null,
    });
  });

  it('restarts the cycle at an auto-advance and remembers when it fired', () => {
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', at(70.01), at(70));
    expect(snapshotAt(71)).toMatchObject({ status: 'running', cycleStartMs: at(70.01), lastAdvanceMs: at(70) });
  });

  it('freezes the elapsed rest while paused', () => {
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    pauseRestTimer(at(25));
    expect(snapshotAt(90)).toEqual({
      status: 'paused',
      targetSeconds: 60,
      lastAdvanceMs: null,
      lastTickAt: iso(10),
      frozenElapsedSeconds: 15,
    });
  });

  it('keeps the live clock and says the queue ended', () => {
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    noteRestTimerQueueEnded();
    expect(snapshotAt(80)).toMatchObject({ status: 'queueEnded', cycleStartMs: at(10), deadlineMs: at(70) });
  });

  it('never wakes by itself: its next change is a store write', () => {
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    expect(getSessionTimerWakeMs(snapshotAt(30))).toBeNull();
  });
});

describe('onTheMinute', () => {
  it('runs the current window from the arm', () => {
    armRestTimer('onTheMinute', at(0), null);
    expect(snapshotAt(30, { mode: 'onTheMinute' })).toEqual({
      status: 'running',
      targetSeconds: 60,
      lastAdvanceMs: null,
      lastTickAt: null,
      cycleStartMs: at(0),
      deadlineMs: at(60),
      periodSeconds: 60,
    });
  });

  it('rolls to the next window on the beat, with no store write', () => {
    armRestTimer('onTheMinute', at(0), null);
    expect(snapshotAt(59.9, { mode: 'onTheMinute' })).toMatchObject({ cycleStartMs: at(0), deadlineMs: at(60) });
    expect(snapshotAt(60, { mode: 'onTheMinute' })).toMatchObject({ cycleStartMs: at(60), deadlineMs: at(120) });
    expect(snapshotAt(185, { mode: 'onTheMinute' })).toMatchObject({ cycleStartMs: at(180), deadlineMs: at(240) });
  });

  it('wakes at the end of the window', () => {
    armRestTimer('onTheMinute', at(0), null);
    expect(getSessionTimerWakeMs(snapshotAt(30, { mode: 'onTheMinute' }))).toBe(at(60));
  });

  it('never lands on a beat that already fired, even with the clock stepped back', () => {
    armRestTimer('onTheMinute', at(0), null);
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'onTheMinute', at(60), at(60));
    expect(snapshotAt(59.99, { mode: 'onTheMinute' })).toMatchObject({
      cycleStartMs: at(60),
      deadlineMs: at(120),
      lastAdvanceMs: at(60),
    });
  });

  it('a tick does not move the window, but is still seen', () => {
    armRestTimer('onTheMinute', at(0), null);
    noteRestTimerTick(iso(20), 'onTheMinute', at(20));
    expect(snapshotAt(30, { mode: 'onTheMinute' })).toMatchObject({ cycleStartMs: at(0), lastTickAt: iso(20) });
  });
});

describe('phase precedence (the pill and the Lock Screen payload agree)', () => {
  it('paused beats a queue that ended', () => {
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    noteRestTimerQueueEnded();
    pauseRestTimer(at(20));
    expect(snapshotAt(30).status).toBe('paused');
  });

  it('waiting for a tick beats a queue that ended', () => {
    armRestTimer('afterTick', at(0), null);
    noteRestTimerQueueEnded();
    expect(snapshotAt(30).status).toBe('waiting');
  });

  it('a queue that ended beats count-up', () => {
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    noteRestTimerQueueEnded();
    expect(snapshotAt(30, { targetSeconds: null }).status).toBe('queueEnded');
  });

  it('a rest length of zero or less reads as none', () => {
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    expect(snapshotAt(30, { targetSeconds: 0 })).toMatchObject({ status: 'countUp', targetSeconds: null });
  });
});
