// What the gym timer is told. Every restart here is paired with a case that must
// NOT restart: a wrong restart zeroes a clock on the wall that five climbers are
// reading.
import { beforeEach, describe, expect, it } from 'vitest';
import type { RestTimerMode } from '../../rest-timer';
import {
  armRestTimer,
  clearRestTimerQueueEnded,
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
} from '../../rest-timer-store';
import { buildSessionTimerSnapshot, type SessionTimerSnapshot } from '../snapshot';
import { deriveSessionTimerCommands, deriveSessionTimerTickCommand, type SessionTimerCommand } from '../commands';

const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const at = (seconds: number) => T0 + seconds * 1000;
const iso = (seconds: number) => new Date(at(seconds)).toISOString();

type Pacing = { targetSeconds: number | null; mode: RestTimerMode };

/**
 * Plays the store the way the sink sees it: a snapshot after each write, diffed
 * against the one before. The first snapshot is the sink mounting.
 */
function follow(pacing: Pacing = { targetSeconds: 60, mode: 'afterTick' }) {
  let previous: SessionTimerSnapshot | null = null;
  return {
    /** The commands for the state as it is now, seen at `seconds`. */
    at(seconds: number, nextPacing: Pacing = pacing): SessionTimerCommand[] {
      const nowMs = at(seconds);
      const next = buildSessionTimerSnapshot({
        state: getRestTimerState(),
        pacing: nextPacing,
        sessionId: null,
        nowMs,
      });
      const commands = deriveSessionTimerCommands(previous, next, nowMs);
      previous = next;
      return commands;
    },
  };
}

const restartFrom = (seconds: number): SessionTimerCommand[] => [{ kind: 'restartCountUp', cycleStartMs: at(seconds) }];

beforeEach(() => {
  resetRestTimerStoreForTests();
});

describe('connecting', () => {
  it('never restarts the clock when the sink mounts, whatever the timer is doing', () => {
    armRestTimer('onTheMinute', at(0), null);
    expect(deriveSessionTimerCommands(null, buildSnapshot(1, 'onTheMinute'), at(1))).toEqual([]);
  });
});

describe('afterTick restarts', () => {
  it('restarts on a fresh tick', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    sink.at(0);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    expect(sink.at(10)).toEqual(restartFrom(10));
  });

  it('restarts on an auto-advance', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    sink.at(10);
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', at(70.02), at(70));
    expect(sink.at(70.02)).toEqual(restartFrom(70.02));
  });

  it('restarts on an auto-advance that clears the anchor (a tick or send rule)', () => {
    // The workout pacing PR clears the anchor at the fire; the advance still
    // moved the wall, so the gym clock restarts from it.
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    const prev = buildSnapshot(10, 'afterTick');
    const next: SessionTimerSnapshot = {
      status: 'waiting',
      targetSeconds: 60,
      lastAdvanceMs: at(70),
      lastTickAt: iso(10),
    };
    expect(deriveSessionTimerCommands(prev, next, at(70.01))).toEqual(restartFrom(70));
  });

  it('restarts on Reset', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    sink.at(10);
    resetRestTimer(at(30));
    expect(sink.at(30)).toEqual(restartFrom(30));
  });

  it('restarts when a refilled queue picks the rest back up', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    noteRestTimerQueueEnded();
    sink.at(70);
    clearRestTimerQueueEnded(at(200), 'afterTick');
    expect(sink.at(200)).toEqual(restartFrom(200));
  });

  it('restarts when a rest that ran out in the background starts again', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    sink.at(10);
    reanchorRestTimerAfterBackground(at(300), at(70));
    expect(sink.at(300)).toEqual(restartFrom(300));
  });

  it('restarts on a tick logged while paused, which resumes the rest', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    pauseRestTimer(at(25));
    sink.at(25);
    noteRestTimerTick(iso(40), 'afterTick', at(40));
    expect(sink.at(40)).toEqual(restartFrom(40));
  });

  it('restarts on a tick logged while paused that took a moment to save, never reading it as a resume', () => {
    // The tick is dated at submit and lands when the save returns, 1.5 s later.
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    pauseRestTimer(at(25));
    sink.at(25);
    noteRestTimerTick(iso(40), 'afterTick', at(41.5));
    expect(sink.at(41.5)).toEqual(restartFrom(40));
  });

  it('restarts on a tick that took several seconds to save on gym wifi', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    sink.at(10);
    noteRestTimerTick(iso(30), 'afterTick', at(38));
    expect(sink.at(38)).toEqual(restartFrom(30));
  });
});

describe('afterTick does not restart', () => {
  it('on a tick backdated more than a minute', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    sink.at(0);
    noteRestTimerTick(iso(100), 'afterTick', at(200));
    expect(sink.at(200)).toEqual([]);
  });

  it('on a cold-start hydration of an old tick', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    sink.at(500);
    noteRestTimerTick(iso(300), 'afterTick', at(500));
    expect(sink.at(500)).toEqual([]);
  });

  it('on a pause', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    sink.at(10);
    pauseRestTimer(at(25));
    expect(sink.at(25)).toEqual([]);
  });

  it('on a resume that carries the rest already counted', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    sink.at(10);
    pauseRestTimer(at(25));
    sink.at(25);
    resumeRestTimer(at(90));
    expect(sink.at(90)).toEqual([]);
  });

  it('on a store write that changes nothing it shows (the queue ending)', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    sink.at(10);
    noteRestTimerQueueEnded();
    expect(sink.at(70)).toEqual([]);
  });

  it('on a new rest length mid-rest', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    sink.at(10);
    expect(sink.at(20, { targetSeconds: 120, mode: 'afterTick' })).toEqual([]);
  });

  it('on the same state seen twice', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    expect(sink.at(10)).toEqual([]);
    expect(sink.at(11)).toEqual([]);
  });

  it('on arming: nothing is counting until the first tick', () => {
    const sink = follow();
    sink.at(0);
    armRestTimer('afterTick', at(0), null);
    expect(sink.at(0)).toEqual([]);
  });
});

describe('resume after a reset while paused', () => {
  it('restarts: the reset dropped the rest, so the resume starts a new one', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    sink.at(10);
    pauseRestTimer(at(25));
    sink.at(25);
    resetRestTimer(at(30));
    expect(sink.at(30)).toEqual([]);
    resumeRestTimer(at(40));
    expect(sink.at(40)).toEqual(restartFrom(40));
  });
});

describe('onTheMinute', () => {
  const fixed: Pacing = { targetSeconds: 60, mode: 'onTheMinute' };

  it('restarts when armed: the first window starts now', () => {
    const sink = follow(fixed);
    sink.at(0);
    armRestTimer('onTheMinute', at(0), null);
    expect(sink.at(0)).toEqual(restartFrom(0));
  });

  it('restarts once per beat, whether the beat or the fire is seen first', () => {
    const sink = follow(fixed);
    armRestTimer('onTheMinute', at(0), null);
    sink.at(1);
    // The sink's wake lands just after the beat.
    expect(sink.at(60.025)).toEqual(restartFrom(60));
    // Then the scheduler's fire on the same beat.
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'onTheMinute', at(60.03), at(60));
    expect(sink.at(60.03)).toEqual([]);
    // And the other order on the next beat.
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'onTheMinute', at(120), at(120));
    expect(sink.at(120)).toEqual(restartFrom(120));
    expect(sink.at(120.025)).toEqual([]);
  });

  it('restarts on every beat with auto-advance off too', () => {
    const sink = follow(fixed);
    armRestTimer('onTheMinute', at(0), null);
    sink.at(1);
    expect(sink.at(60.025)).toEqual(restartFrom(60));
    expect(sink.at(120.025)).toEqual(restartFrom(120));
  });

  it('a tick does not restart it: the window holds', () => {
    const sink = follow(fixed);
    armRestTimer('onTheMinute', at(0), null);
    sink.at(1);
    noteRestTimerTick(iso(20), 'onTheMinute', at(20));
    expect(sink.at(20)).toEqual([]);
  });

  it('a resume keeps the window and restarts nothing', () => {
    const sink = follow(fixed);
    armRestTimer('onTheMinute', at(0), null);
    sink.at(1);
    pauseRestTimer(at(30));
    sink.at(30);
    resumeRestTimer(at(100));
    expect(sink.at(100)).toEqual([]);
  });

  it('a beat that rolled more than a minute ago (woken late from the background) restarts nothing', () => {
    const sink = follow({ targetSeconds: 120, mode: 'onTheMinute' });
    armRestTimer('onTheMinute', at(0), null);
    sink.at(1);
    expect(sink.at(190)).toEqual([]);
  });

  it('a beat seen late in a short window waits for the next beat instead of starting off it', () => {
    // A locked phone holds the wake for the 60 s beat until the unlock at 97 s.
    // The Rogue could only start from 0:00 then, while the window reads 0:37.
    const sink = follow(fixed);
    armRestTimer('onTheMinute', at(0), null);
    sink.at(1);
    expect(sink.at(97)).toEqual([]);
    expect(sink.at(120.025)).toEqual(restartFrom(120));
  });

  it('a tick in the same snapshot as a late beat does not excuse it', () => {
    const sink = follow(fixed);
    armRestTimer('onTheMinute', at(0), null);
    sink.at(1);
    noteRestTimerTick(iso(96), 'onTheMinute', at(96));
    expect(sink.at(97)).toEqual([]);
  });

  it('a shorter rest length mid-window waits for the next beat', () => {
    // 120 s windows cut to 60 s at 90 s: the current window now started at 60 s.
    const sink = follow({ targetSeconds: 120, mode: 'onTheMinute' });
    armRestTimer('onTheMinute', at(0), null);
    sink.at(1);
    expect(sink.at(90, fixed)).toEqual([]);
    expect(sink.at(120.025, fixed)).toEqual(restartFrom(120));
  });

  it('an auto-advance a few seconds late still restarts it: the wall moved', () => {
    const sink = follow(fixed);
    armRestTimer('onTheMinute', at(0), null);
    sink.at(1);
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'onTheMinute', at(64.9), at(60));
    expect(sink.at(65.2)).toEqual(restartFrom(60));
  });
});

describe('switching off', () => {
  it('resets the clock when the timer is disarmed', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    noteRestTimerTick(iso(10), 'afterTick', at(10));
    sink.at(10);
    disarmRestTimer();
    expect(sink.at(20)).toEqual([{ kind: 'reset' }]);
  });

  it('resets once, not on every later change while off', () => {
    const sink = follow();
    armRestTimer('afterTick', at(0), null);
    sink.at(0);
    disarmRestTimer();
    expect(sink.at(1)).toEqual([{ kind: 'reset' }]);
    expect(sink.at(2)).toEqual([]);
  });

  it('is quiet when it was never on', () => {
    const sink = follow();
    sink.at(0);
    expect(sink.at(1)).toEqual([]);
  });
});

describe('a tick with the rest timer off', () => {
  it('restarts the clock from now, as every tick did before', () => {
    expect(deriveSessionTimerTickCommand({ restTimerArmed: false, climbedAtMs: at(9), nowMs: at(10) })).toEqual({
      kind: 'restartCountUp',
      cycleStartMs: at(10),
    });
  });

  it('reads an unparseable timestamp as now', () => {
    expect(deriveSessionTimerTickCommand({ restTimerArmed: false, climbedAtMs: null, nowMs: at(10) })).toEqual({
      kind: 'restartCountUp',
      cycleStartMs: at(10),
    });
  });

  it('ignores a tick backdated more than a minute', () => {
    expect(deriveSessionTimerTickCommand({ restTimerArmed: false, climbedAtMs: at(0), nowMs: at(61) })).toBeNull();
  });

  it('leaves an armed timer to the snapshot', () => {
    expect(deriveSessionTimerTickCommand({ restTimerArmed: true, climbedAtMs: at(10), nowMs: at(10) })).toBeNull();
  });
});

function buildSnapshot(seconds: number, mode: RestTimerMode): SessionTimerSnapshot {
  return buildSessionTimerSnapshot({
    state: getRestTimerState(),
    pacing: { targetSeconds: 60, mode },
    sessionId: null,
    nowMs: at(seconds),
  });
}
