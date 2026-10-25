// The rest-timer store's workout context (#5380, #6231): the stage pacing of the
// climb on the wall, the last tick and the queue item it was logged on, and what
// a fire or a stage change does to the anchor. The default arguments must keep
// every existing caller on exactly today's behaviour.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyRestTimerStagePacing,
  armRestTimer,
  clearRestTimerQueueEnded,
  disarmRestTimer,
  getRestTimerState,
  noteRestTimerAdvancedFrom,
  noteRestTimerAutoAdvanceFired,
  noteRestTimerQueueEnded,
  noteRestTimerTick,
  pauseRestTimer,
  resetRestTimerStoreForTests,
  resumeRestTimer,
  subscribeRestTimer,
} from '../rest-timer-store';
import { restAdvanceAllowed, type RestTimerStagePacing } from '../rest-timer-pacing';
import { getAutoAdvanceDeadlineMs } from '../rest-timer-auto-advance';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');
const tickAt = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

const LIMIT_STAGE: RestTimerStagePacing = {
  sessionId: 'session-1',
  stageId: 'stage-limit',
  kind: 'limitBouldering',
  queueItemUuid: 'queue-1',
  mode: 'afterTick',
  targetSeconds: 180,
  advanceOn: 'send',
  closesSet: false,
  stagePacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
};

const EMOM_STAGE: RestTimerStagePacing = {
  sessionId: 'session-1',
  stageId: 'stage-emom',
  kind: 'onTheMinute',
  queueItemUuid: 'queue-2',
  mode: 'onTheMinute',
  targetSeconds: 60,
  advanceOn: 'deadline',
  closesSet: false,
  stagePacing: { mode: 'onTheMinute', restSeconds: 60 },
};

/** A 4x4 on queue-1 with every rep of its set logged: the 3:00 set rest, then the wall moves. */
const CLOSED_SET_STAGE: RestTimerStagePacing = {
  sessionId: 'session-1',
  stageId: 'stage-4x4',
  kind: 'fourByFour',
  queueItemUuid: 'queue-1',
  mode: 'afterTick',
  targetSeconds: 180,
  advanceOn: 'tick',
  closesSet: true,
  reps: { logged: 4, perSet: 4 },
  stagePacing: {
    mode: 'afterTick',
    restSeconds: 0,
    advanceOn: 'set',
    sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 },
  },
};

/** Whether the scheduler would move the wall off queue-1 under the closed set, and when. */
function setAdvance(nowMs: number): { allowed: boolean; deadlineMs: number | null } {
  const { lastTick, anchorMs, lastFiredDeadlineMs, advancedFromQueueItemUuid, stagePacing } = getRestTimerState();
  return {
    allowed: restAdvanceAllowed({
      advanceOn: 'tick',
      currentQueueItemUuid: 'queue-1',
      lastTick,
      stage: stagePacing,
      advancedFromQueueItemUuid,
    }),
    deadlineMs: getAutoAdvanceDeadlineMs({
      mode: 'afterTick',
      anchorMs,
      targetSeconds: 180,
      nowMs,
      lastFiredDeadlineMs,
    }),
  };
}

beforeEach(() => {
  resetRestTimerStoreForTests();
});

describe('the last tick', () => {
  it('records how a tick went and the queue item it was logged on, in both cadences', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(5), 'afterTick', T0 + 5_000, { status: 'attempt', queueItemUuid: 'queue-1' });
    expect(getRestTimerState()).toMatchObject({
      anchorMs: T0 + 5_000,
      lastTick: { status: 'attempt', queueItemUuid: 'queue-1' },
    });

    armRestTimer('onTheMinute', T0, 'session-1');
    noteRestTimerTick(tickAt(20), 'onTheMinute', T0 + 20_000, { status: 'send', queueItemUuid: 'queue-2' });
    expect(getRestTimerState()).toMatchObject({
      anchorMs: T0,
      lastTick: { status: 'send', queueItemUuid: 'queue-2' },
    });
  });

  it('keeps the last one when a tick names no outcome (a cold-start read of the session)', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(5), 'afterTick', T0 + 5_000, { status: 'send', queueItemUuid: 'queue-1' });
    noteRestTimerTick(tickAt(9), 'afterTick', T0 + 9_000);
    expect(getRestTimerState()).toMatchObject({
      anchorMs: T0 + 9_000,
      lastTick: { status: 'send', queueItemUuid: 'queue-1' },
    });
  });

  it('keeps the last one when a tick counts for no queue item, so a list tick never cancels an earned advance', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(5), 'afterTick', T0 + 5_000, { status: 'send', queueItemUuid: 'queue-1' });
    noteRestTimerTick(tickAt(60), 'afterTick', T0 + 60_000, { status: 'attempt', queueItemUuid: null });
    expect(getRestTimerState()).toMatchObject({
      anchorMs: T0 + 60_000,
      lastTickAt: tickAt(60),
      lastTick: { status: 'send', queueItemUuid: 'queue-1' },
    });

    // Nothing to keep: it stays empty rather than taking the list tick.
    armRestTimer('afterTick', T0 + 100_000, 'session-1');
    noteRestTimerTick(tickAt(105), 'afterTick', T0 + 105_000, { status: 'send', queueItemUuid: null });
    expect(getRestTimerState().lastTick).toBeNull();
  });

  it('keeps the wall climb’s tick when a late tick on the previous climb lands after it', () => {
    armRestTimer('afterTick', T0, 'session-1');
    applyRestTimerStagePacing({ ...LIMIT_STAGE, queueItemUuid: 'queue-2' }, T0, 'none');
    noteRestTimerTick(tickAt(10), 'afterTick', T0 + 10_000, { status: 'send', queueItemUuid: 'queue-2' });

    // A save started on queue-1 before the advance, finishing now.
    noteRestTimerTick(tickAt(5), 'afterTick', T0 + 20_000, { status: 'attempt', queueItemUuid: 'queue-1' });
    expect(getRestTimerState()).toMatchObject({
      lastTick: { status: 'send', queueItemUuid: 'queue-2' },
      // It still goes through the anchor floor, and still shows as the last tick.
      anchorMs: T0 + 10_000,
      lastTickAt: tickAt(5),
    });
  });

  it('takes a tick on another climb while the wall climb has none, and the wall climb’s own over it', () => {
    armRestTimer('afterTick', T0, 'session-1');
    applyRestTimerStagePacing({ ...LIMIT_STAGE, queueItemUuid: 'queue-2' }, T0, 'none');

    noteRestTimerTick(tickAt(5), 'afterTick', T0 + 5_000, { status: 'send', queueItemUuid: 'queue-1' });
    expect(getRestTimerState().lastTick).toEqual({ status: 'send', queueItemUuid: 'queue-1' });
    noteRestTimerTick(tickAt(6), 'afterTick', T0 + 6_000, { status: 'attempt', queueItemUuid: 'queue-3' });
    expect(getRestTimerState().lastTick).toEqual({ status: 'attempt', queueItemUuid: 'queue-3' });

    noteRestTimerTick(tickAt(20), 'afterTick', T0 + 20_000, { status: 'attempt', queueItemUuid: 'queue-2' });
    expect(getRestTimerState().lastTick).toEqual({ status: 'attempt', queueItemUuid: 'queue-2' });
    // The wall climb's next tick replaces its own: a fall, then the send.
    noteRestTimerTick(tickAt(90), 'afterTick', T0 + 90_000, { status: 'send', queueItemUuid: 'queue-2' });
    expect(getRestTimerState().lastTick).toEqual({ status: 'send', queueItemUuid: 'queue-2' });
  });

  it('lets every tick on a queue item replace the last one while no stage names the climb on the wall', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(5), 'afterTick', T0 + 5_000, { status: 'send', queueItemUuid: 'queue-2' });
    noteRestTimerTick(tickAt(9), 'afterTick', T0 + 9_000, { status: 'attempt', queueItemUuid: 'queue-1' });
    expect(getRestTimerState().lastTick).toEqual({ status: 'attempt', queueItemUuid: 'queue-1' });
  });

  it('is forgotten on arm and on disarm, so an old tick never moves a new rest', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(5), 'afterTick', T0 + 5_000, { status: 'send', queueItemUuid: 'queue-1' });
    armRestTimer('afterTick', T0 + 10_000, 'session-1');
    expect(getRestTimerState().lastTick).toBeNull();

    noteRestTimerTick(tickAt(15), 'afterTick', T0 + 15_000, { status: 'send', queueItemUuid: 'queue-1' });
    disarmRestTimer();
    expect(getRestTimerState().lastTick).toBeNull();
  });

  it('is never recorded while the timer is off', () => {
    noteRestTimerTick(tickAt(5), 'afterTick', T0 + 5_000, { status: 'send', queueItemUuid: 'queue-1' });
    expect(getRestTimerState().lastTick).toBeNull();
  });
});

describe('a go whose save lands more than a minute after it was logged', () => {
  it('is fresh by when it was logged: the last tick, its rest anchored at the go', () => {
    armRestTimer('afterTick', T0, 'session-1');
    applyRestTimerStagePacing(CLOSED_SET_STAGE, T0, 'none');
    // Logged at 10 s, climbed then; the save lands at 100 s.
    noteRestTimerTick(tickAt(10), 'afterTick', T0 + 100_000, { status: 'send', queueItemUuid: 'queue-1' }, T0 + 10_000);

    expect(getRestTimerState()).toMatchObject({
      lastTick: { status: 'send', queueItemUuid: 'queue-1' },
      anchorMs: T0 + 10_000,
      lastTickAt: tickAt(10),
    });
    expect(setAdvance(T0 + 100_000)).toEqual({ allowed: true, deadlineMs: T0 + 190_000 });
  });

  it('is history when dated 2 min before it was logged, however soon or late it lands', () => {
    for (const landedAtMs of [T0 + 10_000, T0 + 100_000]) {
      armRestTimer('afterTick', T0, 'session-1');
      applyRestTimerStagePacing(CLOSED_SET_STAGE, T0, 'none');
      noteRestTimerTick(
        tickAt(-110),
        'afterTick',
        landedAtMs,
        { status: 'send', queueItemUuid: 'queue-1' },
        T0 + 10_000,
      );

      expect(getRestTimerState().lastTick).toBeNull();
      expect(setAdvance(landedAtMs).allowed).toBe(false);
    }
  });

  it('with no log instant (a tick read back from the session) is judged on landing, as before', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(10), 'afterTick', T0 + 100_000, { status: 'send', queueItemUuid: 'queue-1' });
    expect(getRestTimerState().lastTick).toBeNull();
  });
});

describe('the fire', () => {
  function armWithSend(): number {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(0), 'afterTick', T0, { status: 'send', queueItemUuid: 'queue-1' });
    return getRestTimerState().cycleId;
  }

  it('restarts an after-tick rest at the fire by default, as it always has', () => {
    const cycleId = armWithSend();
    expect(noteRestTimerAutoAdvanceFired(cycleId, 'afterTick', T0 + 60_000, T0 + 60_000)).toBe(true);
    expect(getRestTimerState()).toMatchObject({
      anchorMs: T0 + 60_000,
      lastTick: { status: 'send', queueItemUuid: 'queue-1' },
      lastFiredDeadlineMs: T0 + 60_000,
    });
  });

  it('keeps an on-the-minute beat by default', () => {
    armRestTimer('onTheMinute', T0, 'session-1');
    const { cycleId } = getRestTimerState();
    noteRestTimerAutoAdvanceFired(cycleId, 'onTheMinute', T0 + 60_000, T0 + 60_000);
    expect(getRestTimerState().anchorMs).toBe(T0);
  });

  it('under a tick or send rule leaves no anchor and forgets the tick, so the next climb waits for its own', () => {
    const cycleId = armWithSend();
    expect(noteRestTimerAutoAdvanceFired(cycleId, 'afterTick', T0 + 180_000, T0 + 180_000, 'clear')).toBe(true);
    expect(getRestTimerState()).toMatchObject({
      anchorMs: null,
      lastTick: null,
      isRunning: true,
      lastFiredDeadlineMs: T0 + 180_000,
      cycleId: cycleId + 1,
    });
  });

  it('still refuses a stale cycle, whatever the anchor rule', () => {
    const cycleId = armWithSend();
    expect(noteRestTimerAutoAdvanceFired(cycleId - 1, 'afterTick', T0 + 180_000, T0 + 180_000, 'clear')).toBe(false);
    expect(getRestTimerState()).toMatchObject({ anchorMs: T0, lastTick: { status: 'send' } });
  });
});

describe('the climb the timer last moved the wall off', () => {
  function moveOnFrom(queueItemUuid: string) {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(0), 'afterTick', T0, { status: 'send', queueItemUuid });
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', T0 + 20_000, T0 + 20_000, 'clear');
    noteRestTimerAdvancedFrom(queueItemUuid);
  }

  it('is remembered by the advance, and only while the timer is on', () => {
    noteRestTimerAdvancedFrom('queue-1');
    expect(getRestTimerState().advancedFromQueueItemUuid).toBeNull();
    moveOnFrom('queue-1');
    expect(getRestTimerState().advancedFromQueueItemUuid).toBe('queue-1');
  });

  it('is cleared by a fresh tick on that climb: the climber went again', () => {
    moveOnFrom('queue-1');
    noteRestTimerTick(tickAt(40), 'afterTick', T0 + 40_000, { status: 'attempt', queueItemUuid: 'queue-1' });
    expect(getRestTimerState()).toMatchObject({
      advancedFromQueueItemUuid: null,
      lastTick: { status: 'attempt', queueItemUuid: 'queue-1' },
    });
  });

  it('stays through a tick on another climb, a tick from a list, and yesterday’s send on that climb', () => {
    moveOnFrom('queue-1');
    noteRestTimerTick(tickAt(30), 'afterTick', T0 + 30_000, { status: 'send', queueItemUuid: 'queue-2' });
    noteRestTimerTick(tickAt(31), 'afterTick', T0 + 31_000, { status: 'send', queueItemUuid: null });
    noteRestTimerTick(tickAt(-86_400), 'afterTick', T0 + 32_000, { status: 'send', queueItemUuid: 'queue-1' });
    expect(getRestTimerState().advancedFromQueueItemUuid).toBe('queue-1');
  });

  it('is forgotten on arm and on disarm', () => {
    moveOnFrom('queue-1');
    armRestTimer('afterTick', T0 + 60_000, 'session-1');
    expect(getRestTimerState().advancedFromQueueItemUuid).toBeNull();
    moveOnFrom('queue-1');
    disarmRestTimer();
    expect(getRestTimerState().advancedFromQueueItemUuid).toBeNull();
  });

  it('never blocks a rep after a disarm and re-arm: that rep earns the set rest and one advance', () => {
    applyRestTimerStagePacing(CLOSED_SET_STAGE, T0, 'none');
    moveOnFrom('queue-1');
    expect(setAdvance(T0 + 20_000).allowed).toBe(false);

    disarmRestTimer();
    armRestTimer('afterTick', T0 + 30_000, 'session-1');
    noteRestTimerTick(tickAt(40), 'afterTick', T0 + 40_000, { status: 'attempt', queueItemUuid: 'queue-1' });
    expect(setAdvance(T0 + 40_000)).toEqual({ allowed: true, deadlineMs: T0 + 220_000 });

    // The advance spends it: the climb never moves on again from that rep.
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', T0 + 220_000, T0 + 220_000, 'clear');
    noteRestTimerAdvancedFrom('queue-1');
    expect(setAdvance(T0 + 220_000).allowed).toBe(false);
  });
});

describe('a refilled queue', () => {
  it('restarts an after-tick rest by default, and waits for a tick under a tick or send rule', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(0), 'afterTick', T0, { status: 'send', queueItemUuid: 'queue-1' });
    noteRestTimerQueueEnded();
    clearRestTimerQueueEnded(T0 + 300_000, 'afterTick');
    expect(getRestTimerState()).toMatchObject({
      queueEnded: false,
      anchorMs: T0 + 300_000,
      lastTick: { status: 'send', queueItemUuid: 'queue-1' },
    });

    noteRestTimerQueueEnded();
    clearRestTimerQueueEnded(T0 + 400_000, 'afterTick', 'clear');
    // The send's rest already ran out at the dead end: like the fire, the
    // refill forgets it, so a Reset or a tick-less re-anchor cannot walk on.
    expect(getRestTimerState()).toMatchObject({ queueEnded: false, anchorMs: null, lastTick: null });
  });
});

describe('the stage pacing', () => {
  it('is stored while the timer is off, and arming or turning it off keeps it', () => {
    applyRestTimerStagePacing(LIMIT_STAGE, T0, 'waitForTick');
    expect(getRestTimerState()).toMatchObject({ stagePacing: LIMIT_STAGE, armed: false, anchorMs: null });

    armRestTimer('afterTick', T0, 'session-1');
    expect(getRestTimerState().stagePacing).toBe(LIMIT_STAGE);
    disarmRestTimer();
    expect(getRestTimerState().stagePacing).toBe(LIMIT_STAGE);
  });

  it('changes nothing, and tells no one, when the pacing is the same', () => {
    armRestTimer('afterTick', T0, 'session-1');
    applyRestTimerStagePacing(LIMIT_STAGE, T0, 'waitForTick');
    const before = getRestTimerState();
    let notified = 0;
    subscribeRestTimer(() => {
      notified += 1;
    });

    applyRestTimerStagePacing({ ...LIMIT_STAGE, stagePacing: { ...LIMIT_STAGE.stagePacing } }, T0 + 5_000, 'anchorNow');

    expect(getRestTimerState()).toBe(before);
    expect(notified).toBe(0);
  });

  it('anchorNow starts an on-the-minute beat at the stage change, mid-window or not', () => {
    // A warm-up rest fired at T0 + 300 s and the first on-the-minute climb is up.
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(240), 'afterTick', T0 + 240_000);
    const { cycleId, lastTickAt } = getRestTimerState();

    applyRestTimerStagePacing(EMOM_STAGE, T0 + 300_000, 'anchorNow');

    expect(getRestTimerState()).toMatchObject({
      stagePacing: EMOM_STAGE,
      anchorMs: T0 + 300_000,
      pausedElapsedSeconds: 0,
      cycleId: cycleId + 1,
      lastTickAt,
    });
  });

  it('waitForTick clears the anchor so the new climb rests only once it is logged', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(0), 'afterTick', T0, { status: 'send', queueItemUuid: 'queue-0' });
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', T0 + 60_000, T0 + 60_000);
    const { cycleId } = getRestTimerState();

    applyRestTimerStagePacing(LIMIT_STAGE, T0 + 61_000, 'waitForTick');

    expect(getRestTimerState()).toMatchObject({
      stagePacing: LIMIT_STAGE,
      anchorMs: null,
      cycleId: cycleId + 1,
      lastFiredDeadlineMs: T0 + 60_000,
      lastTickAt: tickAt(0),
    });
  });

  it('applies to a paused timer too, so Resume gives the first climb on the minute its whole interval', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(0), 'afterTick', T0);
    pauseRestTimer(T0 + 40_000);
    const paused = getRestTimerState();

    applyRestTimerStagePacing(EMOM_STAGE, T0 + 50_000, 'anchorNow');

    expect(getRestTimerState()).toMatchObject({
      stagePacing: EMOM_STAGE,
      isRunning: false,
      pausedElapsedSeconds: 0,
      cycleId: paused.cycleId + 1,
    });

    // Without the reset, Resume would rebase on the 40 s of the warm-up rest
    // and the first beat would land 20 s in.
    resumeRestTimer(T0 + 70_000);
    expect(getRestTimerState()).toMatchObject({ isRunning: true, anchorMs: T0 + 70_000 });
  });

  it('waitForTick on a paused timer drops the last climb’s rest instead of carrying it onto the new one', () => {
    armRestTimer('afterTick', T0, 'session-1');
    noteRestTimerTick(tickAt(0), 'afterTick', T0, { status: 'send', queueItemUuid: 'queue-0' });
    pauseRestTimer(T0 + 30_000);
    const paused = getRestTimerState();

    applyRestTimerStagePacing(LIMIT_STAGE, T0 + 35_000, 'waitForTick');

    expect(getRestTimerState()).toMatchObject({
      stagePacing: LIMIT_STAGE,
      isRunning: false,
      anchorMs: null,
      pausedElapsedSeconds: 0,
      cycleId: paused.cycleId + 1,
      lastTickAt: tickAt(0),
    });
  });

  it('goes back to null when the workout is over', () => {
    applyRestTimerStagePacing(LIMIT_STAGE, T0, 'none');
    applyRestTimerStagePacing(null, T0 + 1_000, 'none');
    expect(getRestTimerState().stagePacing).toBeNull();
  });
});
