import { beforeEach, describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
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
import { buildRestTimerLiveActivityPayload, type RestTimerPayloadInput } from '../rest-timer-payload';
import type { RestTimerMode } from '../../rest-timer';

const T0 = Date.parse('2026-10-18T10:00:00.000Z');
const SESSION = 'session-1';
const tickAt = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

// Echoes the key and its params, so a caption assertion pins both.
const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key) as unknown as TFunction<'session'>;

function build(overrides: Partial<RestTimerPayloadInput> = {}) {
  return buildRestTimerLiveActivityPayload({
    state: getRestTimerState(),
    targetSeconds: 120,
    mode: 'afterTick',
    showOnLockScreen: true,
    sessionId: SESSION,
    nowMs: T0,
    t,
    ...overrides,
  });
}

function armAndTick(mode: RestTimerMode = 'afterTick', tickOffsetSeconds = 0) {
  armRestTimer(mode, T0, SESSION);
  noteRestTimerTick(tickAt(tickOffsetSeconds), mode, T0 + tickOffsetSeconds * 1000);
}

beforeEach(() => {
  resetRestTimerStoreForTests();
});

describe('when there is nothing to show', () => {
  it('is null while the timer is off', () => {
    expect(build()).toBeNull();
    armAndTick();
    disarmRestTimer();
    expect(build()).toBeNull();
  });

  it('is null when the climber switched the Lock Screen countdown off', () => {
    armAndTick();
    expect(build({ showOnLockScreen: false })).toBeNull();
  });

  it('is null with no session to hang it on', () => {
    armAndTick();
    expect(build({ sessionId: null })).toBeNull();
  });

  it('is null for a timer armed for another session, and carries a pre-session arm into this one', () => {
    armRestTimer('afterTick', T0, 'other-session');
    expect(build()).toBeNull();

    armRestTimer('afterTick', T0, null);
    expect(build()).toMatchObject({ sessionId: SESSION, status: 'waiting' });
  });
});

describe('after each climb', () => {
  it('waits on the rest length before the first tick, never a false 0:00', () => {
    armRestTimer('afterTick', T0, SESSION);
    expect(build()).toEqual({
      sessionId: SESSION,
      status: 'waiting',
      startMs: null,
      deadlineMs: null,
      periodSeconds: null,
      targetSeconds: 120,
      frozenSignedSeconds: 120,
      androidCaption: 'mobile.restTimer.waitingForTick',
    });
  });

  it('waits on 0:00 when the rest length is Off', () => {
    armRestTimer('afterTick', T0, SESSION);
    expect(build({ targetSeconds: null })).toMatchObject({
      status: 'waiting',
      targetSeconds: null,
      frozenSignedSeconds: 0,
    });
  });

  it('counts down one rest from the tick', () => {
    armAndTick('afterTick', 0);
    expect(build({ nowMs: T0 + 30_000 })).toEqual({
      sessionId: SESSION,
      status: 'running',
      startMs: T0,
      deadlineMs: T0 + 120_000,
      periodSeconds: null,
      targetSeconds: 120,
      frozenSignedSeconds: null,
      androidCaption: 'mobile.restTimer.clockCaptionRest:{"target":"2:00"}',
      androidOverCaption: 'mobile.restTimer.clockCaptionOver',
    });
  });

  it('keeps the same window and both captions once the rest is over', () => {
    armAndTick('afterTick', 0);
    // Android picks the over caption itself at the deadline (JS may be
    // suspended by then), so the snapshot is the same either side of zero.
    expect(build({ nowMs: T0 + 150_000 })).toEqual(build({ nowMs: T0 + 30_000 }));
  });

  it('restarts the window from the moment an auto-advance fired', () => {
    armAndTick('afterTick', 0);
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', T0 + 120_000, T0 + 120_000);
    expect(build({ nowMs: T0 + 121_000 })).toMatchObject({ startMs: T0 + 120_000, deadlineMs: T0 + 240_000 });
  });
});

describe('fixed windows', () => {
  it('hands over the current window and its length so native can roll it on', () => {
    armRestTimer('onTheMinute', T0, SESSION);
    expect(build({ mode: 'onTheMinute', targetSeconds: 60, nowMs: T0 + 75_000 })).toEqual({
      sessionId: SESSION,
      status: 'running',
      startMs: T0 + 60_000,
      deadlineMs: T0 + 120_000,
      periodSeconds: 60,
      targetSeconds: 60,
      frozenSignedSeconds: null,
      androidCaption: 'mobile.restTimer.modeEvery:{"length":"1:00"}',
      androidOverCaption: 'mobile.restTimer.clockCaptionOver',
    });
  });

  it('never hands over a window the auto-advance already fired on', () => {
    armRestTimer('onTheMinute', T0, SESSION);
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'onTheMinute', T0 + 60_000, T0 + 60_000);
    // The wall clock stepped back under the fired beat: the scheduler would
    // never count to it again, so neither does the Lock Screen.
    expect(build({ mode: 'onTheMinute', targetSeconds: 60, nowMs: T0 + 59_000 })).toMatchObject({
      startMs: T0 + 60_000,
      deadlineMs: T0 + 120_000,
    });
  });
});

describe('frozen states', () => {
  it('pauses on the time left', () => {
    armAndTick('afterTick', 0);
    pauseRestTimer(T0 + 45_000);
    expect(build({ nowMs: T0 + 90_000 })).toEqual({
      sessionId: SESSION,
      status: 'paused',
      startMs: null,
      deadlineMs: null,
      periodSeconds: null,
      targetSeconds: 120,
      frozenSignedSeconds: 75,
      androidCaption: 'mobile.restTimer.clockCaptionPaused',
    });
  });

  it('pauses on a negative value once over, the same signed number the pill shows', () => {
    armAndTick('afterTick', 0);
    pauseRestTimer(T0 + 130_000);
    expect(build({ nowMs: T0 + 200_000 })).toMatchObject({ status: 'paused', frozenSignedSeconds: -10 });
  });

  it('pauses a count-up on the time since the tick', () => {
    armAndTick('afterTick', 0);
    pauseRestTimer(T0 + 42_000);
    expect(build({ targetSeconds: null })).toMatchObject({ status: 'paused', frozenSignedSeconds: 42 });
  });
});

describe('queue ended', () => {
  // The pill keeps ticking once the queue runs out, so the Lock Screen must too:
  // the same live window as before, only the status and caption change.
  it('keeps counting the rest it was on, past zero too', () => {
    armAndTick('afterTick', 0);
    noteRestTimerQueueEnded();
    expect(build({ nowMs: T0 + 130_000 })).toEqual({
      sessionId: SESSION,
      status: 'queueEnded',
      startMs: T0,
      deadlineMs: T0 + 120_000,
      periodSeconds: null,
      targetSeconds: 120,
      frozenSignedSeconds: null,
      androidCaption: 'mobile.restTimer.queueEnded',
    });
  });

  it('keeps rolling a fixed window', () => {
    armRestTimer('onTheMinute', T0, SESSION);
    noteRestTimerQueueEnded();
    expect(build({ mode: 'onTheMinute', targetSeconds: 60, nowMs: T0 + 75_000 })).toMatchObject({
      status: 'queueEnded',
      startMs: T0 + 60_000,
      deadlineMs: T0 + 120_000,
      periodSeconds: 60,
      frozenSignedSeconds: null,
    });
  });

  it('keeps counting up with no rest length', () => {
    armAndTick('afterTick', 0);
    noteRestTimerQueueEnded();
    expect(build({ targetSeconds: null, nowMs: T0 + 30_000 })).toMatchObject({
      status: 'queueEnded',
      startMs: T0,
      deadlineMs: null,
      frozenSignedSeconds: null,
      androidCaption: 'mobile.restTimer.queueEnded',
    });
  });

  it('still freezes while paused', () => {
    armAndTick('afterTick', 0);
    noteRestTimerQueueEnded();
    pauseRestTimer(T0 + 45_000);
    expect(build({ nowMs: T0 + 90_000 })).toMatchObject({ status: 'paused', frozenSignedSeconds: 75 });
  });
});

describe('no rest length', () => {
  it('counts up from the tick with no deadline', () => {
    armAndTick('afterTick', 0);
    expect(build({ targetSeconds: null, nowMs: T0 + 30_000 })).toEqual({
      sessionId: SESSION,
      status: 'countUp',
      startMs: T0,
      deadlineMs: null,
      periodSeconds: null,
      targetSeconds: null,
      frozenSignedSeconds: null,
      androidCaption: 'mobile.restTimer.clockCaptionCountUp',
    });
  });
});
