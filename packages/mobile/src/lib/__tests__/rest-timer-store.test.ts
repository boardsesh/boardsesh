import { beforeEach, describe, expect, it } from 'vitest';
import {
  armRestTimer,
  bindRestTimerToSession,
  disarmRestTimer,
  floorRestTimerAnchorAtLastAdvance,
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
import {
  AUTO_ADVANCE_MAX_BACKDATE_MS,
  AUTO_ADVANCE_REST_FLOOR_SLACK_MS,
  getAutoAdvanceDeadlineMs,
  getRestTimerCycleElapsedSeconds,
  isAutoAdvanceDeadlineStale,
} from '../rest-timer-auto-advance';

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

  it('holds a fixed window through an attempt, a send and a back-dated tick (#5664)', () => {
    // A boulder every 3:00: try for about a minute, rest out the rest. Nothing
    // logged inside the window may move it — the store sees an attempt and a send
    // the same way (a climbedAt), and an edited earlier tick arrives older still.
    armRestTimer('onTheMinute', T0, 'session-1');
    const { cycleId } = getRestTimerState();

    noteRestTimerTick(tickAt(40), 'onTheMinute', T0 + 40_000); // attempt
    noteRestTimerTick(tickAt(75), 'onTheMinute', T0 + 75_000); // send
    noteRestTimerTick(tickAt(-600), 'onTheMinute', T0 + 90_000); // earlier tick, re-saved

    expect(getRestTimerState()).toMatchObject({ anchorMs: T0, cycleId, isRunning: true });
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

/** When the next after-tick advance is due on a 60 s rest, from the store as it is now. */
function afterTickDeadlineMs(nowMs: number): number | null {
  const { anchorMs, lastFiredDeadlineMs } = getRestTimerState();
  return getAutoAdvanceDeadlineMs({ mode: 'afterTick', anchorMs, targetSeconds: 60, nowMs, lastFiredDeadlineMs });
}

/** Arm an after-tick timer, tick at T0 and fire its 60 s rest at T0 + 60 s. */
function advancedOnceAtSixtySeconds() {
  armRestTimer('afterTick', T0, 'session-1');
  noteRestTimerTick(tickAt(0), 'afterTick', T0);
  noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', T0 + 60_000, T0 + 60_000);
}

describe('the tick floor: a tick never starts a rest before the last advance or the rest already running', () => {
  it('starts the rest at the advance for a send logged 2 s after it but dated 55 s back', () => {
    advancedOnceAtSixtySeconds();
    noteRestTimerTick(tickAt(7), 'afterTick', T0 + 62_000);

    // Anchored at its own time, the deadline would be T0 + 67 s: 7 s after the
    // climber saw the wall change, skipping the climb it just lit.
    expect(getRestTimerState()).toMatchObject({ anchorMs: T0 + 60_000, lastTickAt: tickAt(7) });
    expect(afterTickDeadlineMs(T0 + 62_000)).toBe(T0 + 120_000);
  });

  it('still anchors a tick dated after the advance at its own time', () => {
    advancedOnceAtSixtySeconds();
    noteRestTimerTick(tickAt(61), 'afterTick', T0 + 62_000);

    expect(getRestTimerState().anchorMs).toBe(T0 + 61_000);
    expect(afterTickDeadlineMs(T0 + 62_000)).toBe(T0 + 121_000);
  });

  it('keeps the newly lit climb’s rest when an older tick on the previous climb lands after it', () => {
    advancedOnceAtSixtySeconds();
    const advancedAt = T0 + 60_000;
    noteRestTimerTick(new Date(advancedAt + 20_000).toISOString(), 'afterTick', advancedAt + 20_000, {
      status: 'send',
      queueItemUuid: 'queue-new',
    });
    expect(afterTickDeadlineMs(advancedAt + 20_000)).toBe(advancedAt + 80_000);

    // The previous climb's send, dated 5 s before the advance, saved 30 s after it.
    noteRestTimerTick(new Date(advancedAt - 5_000).toISOString(), 'afterTick', advancedAt + 30_000, {
      status: 'send',
      queueItemUuid: 'queue-previous',
    });
    expect(getRestTimerState()).toMatchObject({
      anchorMs: advancedAt + 20_000,
      lastTickAt: new Date(advancedAt - 5_000).toISOString(),
    });
    expect(afterTickDeadlineMs(advancedAt + 30_000)).toBe(advancedAt + 80_000);
  });

  it('never anchors ahead of the clock when the last fire landed a moment before its deadline', () => {
    // A clock step back: the fire runs 500 ms before the deadline it fired on.
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(0), 'afterTick', T0);
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', T0 + 59_500, T0 + 60_000);
    expect(getRestTimerState().lastFiredDeadlineMs).toBe(T0 + 60_000);

    noteRestTimerTick(new Date(T0 + 59_800).toISOString(), 'afterTick', T0 + 59_800);
    expect(getRestTimerState().anchorMs).toBe(T0 + 59_800);

    // A climbedAt from a clock running ahead of this phone's is capped at now too.
    noteRestTimerTick(tickAt(90), 'afterTick', T0 + 59_900);
    expect(getRestTimerState()).toMatchObject({ anchorMs: T0 + 59_900, lastTickAt: tickAt(90) });
  });

  it('leaves the first tick of a session at its own time, back-dated or not', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(-30), 'afterTick', T0);
    expect(getRestTimerState().anchorMs).toBe(T0 - 30_000);
    expect(afterTickDeadlineMs(T0)).toBe(T0 + 30_000);
  });

  it('fills a missing on-the-minute anchor with the floored tick, never one from before the last beat', () => {
    armRestTimer('onTheMinute', T0, 'session-1');
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'onTheMinute', T0 + 60_000, T0 + 60_000);
    pauseRestTimer(T0 + 65_000);
    resetRestTimer(T0 + 65_000);
    expect(getRestTimerState().anchorMs).toBeNull();

    noteRestTimerTick(tickAt(40), 'onTheMinute', T0 + 70_000);
    expect(getRestTimerState()).toMatchObject({ anchorMs: T0 + 60_000, lastTickAt: tickAt(40) });
  });
});

/** Arm an after-tick timer, send on `queue-1` at T0 and fire its 60 s rest under a send rule (the anchor clears). */
function advancedOnceWaitingForATick() {
  armRestTimer('afterTick', T0, 'session-1');
  noteRestTimerTick(tickAt(0), 'afterTick', T0, { status: 'send', queueItemUuid: 'queue-1' });
  noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', T0 + 60_000, T0 + 60_000, 'clear');
}

const YESTERDAY = tickAt(-24 * 60 * 60);

describe('a tick dated more than a minute before it lands is history', () => {
  it('never earns an advance: the last tick stands, and the running rest is left alone', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(0), 'afterTick', T0, { status: 'attempt', queueItemUuid: 'queue-1' });

    // Yesterday's send on the same climb, logged 10 s into today's rest.
    noteRestTimerTick(YESTERDAY, 'afterTick', T0 + 10_000, { status: 'send', queueItemUuid: 'queue-1' });

    expect(getRestTimerState()).toMatchObject({
      anchorMs: T0,
      lastTick: { status: 'attempt', queueItemUuid: 'queue-1' },
      lastTickAt: YESTERDAY,
    });
  });

  it('starts no rest for the climb just lit: it anchors at its own time, so its deadline is long gone', () => {
    advancedOnceWaitingForATick();
    expect(getRestTimerState()).toMatchObject({ anchorMs: null, lastTick: null });

    noteRestTimerTick(YESTERDAY, 'afterTick', T0 + 62_000, { status: 'send', queueItemUuid: 'queue-2' });

    // Floored like a fresh tick it would anchor on the advance, a live 60 s deadline.
    expect(getRestTimerState()).toMatchObject({ anchorMs: Date.parse(YESTERDAY), lastTick: null });
    expect(isAutoAdvanceDeadlineStale(afterTickDeadlineMs(T0 + 62_000), T0 + 62_000)).toBe(true);
  });

  it('a send just logged on the climb just lit earns its advance and starts its rest at once', () => {
    advancedOnceWaitingForATick();

    noteRestTimerTick(tickAt(62), 'afterTick', T0 + 62_000, { status: 'send', queueItemUuid: 'queue-2' });

    expect(getRestTimerState()).toMatchObject({
      anchorMs: T0 + 62_000,
      lastTick: { status: 'send', queueItemUuid: 'queue-2' },
    });
    expect(afterTickDeadlineMs(T0 + 62_000)).toBe(T0 + 122_000);
  });

  it('judges the tick by its own time, a minute back at most, whatever the floor makes of it', () => {
    advancedOnceWaitingForATick();
    const savedAtMs = T0 + 62_000;

    // Exactly a minute back is still a climb just done: floored onto the advance.
    noteRestTimerTick(new Date(savedAtMs - AUTO_ADVANCE_MAX_BACKDATE_MS).toISOString(), 'afterTick', savedAtMs, {
      status: 'send',
      queueItemUuid: 'queue-2',
    });
    expect(getRestTimerState()).toMatchObject({
      anchorMs: T0 + 60_000,
      lastTick: { status: 'send', queueItemUuid: 'queue-2' },
    });

    resetRestTimerStoreForTests();
    advancedOnceWaitingForATick();
    // A millisecond further back is history.
    const historicalMs = savedAtMs - AUTO_ADVANCE_MAX_BACKDATE_MS - 1;
    noteRestTimerTick(new Date(historicalMs).toISOString(), 'afterTick', savedAtMs, {
      status: 'send',
      queueItemUuid: 'queue-2',
    });
    expect(getRestTimerState()).toMatchObject({ anchorMs: historicalMs, lastTick: null });
  });

  it('never resumes a paused rest onto a live deadline', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(0), 'afterTick', T0);
    pauseRestTimer(T0 + 20_000);

    // Floored, it would resume from T0 with the paused 20 s counted as rest:
    // 60 s up at T0 + 60 s, 30 s after this tick. Anchored at its own time it
    // would drop the pause and count up from yesterday. It does neither.
    const paused = getRestTimerState();
    noteRestTimerTick(YESTERDAY, 'afterTick', T0 + 30_000);

    expect(getRestTimerState()).toMatchObject({
      isRunning: false,
      pausedElapsedSeconds: 20,
      anchorMs: paused.anchorMs,
      lastTick: paused.lastTick,
      lastTickAt: YESTERDAY,
    });
  });

  it.each(['afterTick', 'onTheMinute'] as const)(
    'leaves the dead-end latch set for a historical tick (%s), and a fresh one clears it',
    (mode) => {
      armRestTimer(mode, T0, 'session-1');
      noteRestTimerTick(tickAt(0), mode, T0);
      noteRestTimerQueueEnded();
      const latched = getRestTimerState();

      noteRestTimerTick(YESTERDAY, mode, T0 + 30_000);
      expect(getRestTimerState().queueEnded).toBe(true);
      expect(getRestTimerState().cycleId).toBe(mode === 'onTheMinute' ? latched.cycleId : latched.cycleId + 1);

      noteRestTimerTick(tickAt(40), mode, T0 + 40_000);
      expect(getRestTimerState().queueEnded).toBe(false);
    },
  );

  it('still picks a rest up from a cold start’s last session tick, however old, as it always did', () => {
    armRestTimer('afterTick', T0, 'session-1');

    // The session's last tick, two minutes back, read on arming. On a 3:00 rest a minute is left.
    noteRestTimerTick(tickAt(-120), 'afterTick', T0);

    expect(getRestTimerState().anchorMs).toBe(T0 - 120_000);
    const { anchorMs, lastFiredDeadlineMs } = getRestTimerState();
    expect(
      getAutoAdvanceDeadlineMs({ mode: 'afterTick', anchorMs, targetSeconds: 180, nowMs: T0, lastFiredDeadlineMs }),
    ).toBe(T0 + 60_000);
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

  it('pauses a fixed window past its first beat on the time left in that window, and resumes on the same grid', () => {
    const pacing = { mode: 'onTheMinute' as const, targetSeconds: 60 };
    armRestTimer('onTheMinute', T0, null);
    pauseRestTimer(T0 + 230_000);
    // The store keeps the run's total, so Resume (and a crew PAUSE) rebase on it as before.
    expect(getRestTimerState()).toMatchObject({ isRunning: false, pausedElapsedSeconds: 230 });

    const readout = (nowMs: number) => {
      const { anchorMs, isRunning, pausedElapsedSeconds } = getRestTimerState();
      const elapsedSeconds = getRestTimerCycleElapsedSeconds({
        ...pacing,
        anchorMs,
        nowMs,
        isRunning,
        pausedElapsedSeconds,
      });
      return { elapsedSeconds, remainingSeconds: pacing.targetSeconds - elapsedSeconds };
    };
    // 3:50 in: 0:50 into the fourth window, 0:10 left. It read -2:50 before.
    expect(readout(T0 + 230_000)).toEqual({ elapsedSeconds: 50, remainingSeconds: 10 });
    expect(readout(T0 + 999_000)).toEqual({ elapsedSeconds: 50, remainingSeconds: 10 });

    const resumedAt = T0 + 517_300;
    resumeRestTimer(resumedAt);
    expect(getRestTimerState().anchorMs).toBe(resumedAt - 230_000);
    // Resume picks up exactly where the paused readout stood, and the next beat is the 10 s it showed.
    expect(readout(resumedAt)).toEqual({ elapsedSeconds: 50, remainingSeconds: 10 });
    const deadlineMs = getAutoAdvanceDeadlineMs({ ...pacing, anchorMs: resumedAt - 230_000, nowMs: resumedAt });
    expect(deadlineMs).toBe(resumedAt + 10_000);
    expect(getAutoAdvanceDeadlineMs({ ...pacing, anchorMs: resumedAt - 230_000, nowMs: resumedAt + 10_000 })).toBe(
      resumedAt + 70_000,
    );
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

describe('the after-tick rest floor', () => {
  const ADVANCED_AT_MS = T0 + 60_000;

  /** The advance at T0 + 60 s waits for a tick; 2 s later a send from 85 s ago lands at its own time. */
  function sendFrom85sAgoAfterTheAdvance() {
    advancedOnceWaitingForATick();
    noteRestTimerTick(tickAt(60 + 2 - 85), 'afterTick', ADVANCED_AT_MS + 2_000, {
      status: 'send',
      queueItemUuid: 'queue-2',
    });
    expect(getRestTimerState().anchorMs).toBe(ADVANCED_AT_MS - 83_000);
  }

  it('moves a running rest that began before the advance to 3 s before it, and rolls the cycle', () => {
    sendFrom85sAgoAfterTheAdvance();
    const { cycleId } = getRestTimerState();

    expect(floorRestTimerAnchorAtLastAdvance(cycleId, 'afterTick', 90, ADVANCED_AT_MS + 2_000)).toBe(true);
    expect(getRestTimerState()).toMatchObject({
      anchorMs: ADVANCED_AT_MS - AUTO_ADVANCE_REST_FLOOR_SLACK_MS,
      cycleId: cycleId + 1,
      lastFiredDeadlineMs: ADVANCED_AT_MS,
    });
    const { anchorMs, lastFiredDeadlineMs } = getRestTimerState();
    expect(
      getAutoAdvanceDeadlineMs({
        mode: 'afterTick',
        anchorMs,
        targetSeconds: 90,
        nowMs: ADVANCED_AT_MS + 2_000,
        lastFiredDeadlineMs,
      }),
    ).toBe(ADVANCED_AT_MS + 87_000);

    // Done once: the anchor now stands.
    expect(floorRestTimerAnchorAtLastAdvance(cycleId + 1, 'afterTick', 90, ADVANCED_AT_MS + 2_000)).toBe(false);
  });

  it('never moves a rest that has run out, so it never gives one a live deadline', () => {
    sendFrom85sAgoAfterTheAdvance();
    const before = getRestTimerState();

    // On a 60 s rest that send's rest ran out 23 s before the advance.
    expect(floorRestTimerAnchorAtLastAdvance(before.cycleId, 'afterTick', 60, ADVANCED_AT_MS + 2_000)).toBe(false);
    // On 90 s it runs out at the advance + 7 s; at + 7 s it has.
    expect(floorRestTimerAnchorAtLastAdvance(before.cycleId, 'afterTick', 90, ADVANCED_AT_MS + 7_000)).toBe(false);
    expect(getRestTimerState()).toBe(before);
  });

  it('refuses another cycle, a paused rest, on the minute, and a disarmed timer', () => {
    sendFrom85sAgoAfterTheAdvance();
    const { cycleId } = getRestTimerState();
    const nowMs = ADVANCED_AT_MS + 2_000;

    expect(floorRestTimerAnchorAtLastAdvance(cycleId - 1, 'afterTick', 90, nowMs)).toBe(false);
    expect(floorRestTimerAnchorAtLastAdvance(cycleId, 'onTheMinute', 90, nowMs)).toBe(false);

    pauseRestTimer(nowMs);
    expect(floorRestTimerAnchorAtLastAdvance(getRestTimerState().cycleId, 'afterTick', 90, nowMs)).toBe(false);

    disarmRestTimer();
    expect(floorRestTimerAnchorAtLastAdvance(getRestTimerState().cycleId, 'afterTick', 90, nowMs)).toBe(false);
  });

  it('starts every arm with no last advance, so a re-armed rest keeps its own anchor', () => {
    sendFrom85sAgoAfterTheAdvance();
    armRestTimer('afterTick', ADVANCED_AT_MS + 3_000, 'session-1');
    noteRestTimerTick(tickAt(60 + 3 - 50), 'afterTick', ADVANCED_AT_MS + 3_000);

    expect(getRestTimerState()).toMatchObject({ anchorMs: ADVANCED_AT_MS - 47_000, lastFiredDeadlineMs: null });
    expect(
      floorRestTimerAnchorAtLastAdvance(getRestTimerState().cycleId, 'afterTick', 90, ADVANCED_AT_MS + 3_000),
    ).toBe(false);
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
