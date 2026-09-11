import { describe, expect, it } from 'vitest';
import {
  AUTO_ADVANCE_MAX_BACKDATE_MS,
  getAutoAdvanceDeadlineMs,
  getRestTimerCycleElapsedSeconds,
  isTickFreshEnoughToArm,
  shouldScheduleAutoAdvance,
} from '../rest-timer-auto-advance';
import type { RestTimerState } from '../rest-timer-store';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');

const armedState = (overrides: Partial<RestTimerState> = {}): RestTimerState => ({
  armed: true,
  armedForSessionId: 'session-1',
  anchorMs: T0,
  isRunning: true,
  pausedElapsedSeconds: 0,
  cycleId: 1,
  lastTickAt: null,
  queueEnded: false,
  ...overrides,
});

describe('isTickFreshEnoughToArm', () => {
  it('accepts a tick logged moments ago', () => {
    expect(isTickFreshEnoughToArm(T0, T0 + 10_000)).toBe(true);
  });

  it('rejects a back-dated tick, so saving yesterday cannot yank the wall', () => {
    expect(isTickFreshEnoughToArm(T0 - 5 * 60_000, T0)).toBe(false);
  });

  it('treats the boundary as fresh and one millisecond past it as stale', () => {
    expect(isTickFreshEnoughToArm(T0 - AUTO_ADVANCE_MAX_BACKDATE_MS, T0)).toBe(true);
    expect(isTickFreshEnoughToArm(T0 - AUTO_ADVANCE_MAX_BACKDATE_MS - 1, T0)).toBe(false);
  });

  it('rejects a missing tick', () => {
    expect(isTickFreshEnoughToArm(null, T0)).toBe(false);
  });
});

describe('getAutoAdvanceDeadlineMs', () => {
  it('puts the after-tick deadline one interval past the tick', () => {
    expect(getAutoAdvanceDeadlineMs({ mode: 'afterTick', anchorMs: T0, targetSeconds: 60, nowMs: T0 })).toBe(
      T0 + 60_000,
    );
  });

  it('reports an after-tick deadline already in the past for a back-dated anchor', () => {
    const deadline = getAutoAdvanceDeadlineMs({
      mode: 'afterTick',
      anchorMs: T0 - 300_000,
      targetSeconds: 60,
      nowMs: T0,
    });
    expect(deadline).toBeLessThan(T0);
  });

  it('rolls on-the-minute to the next beat, not the one just missed', () => {
    expect(getAutoAdvanceDeadlineMs({ mode: 'onTheMinute', anchorMs: T0, targetSeconds: 60, nowMs: T0 + 75_000 })).toBe(
      T0 + 120_000,
    );
  });

  it('waits a full interval when armed exactly on a beat', () => {
    expect(getAutoAdvanceDeadlineMs({ mode: 'onTheMinute', anchorMs: T0, targetSeconds: 60, nowMs: T0 })).toBe(
      T0 + 60_000,
    );
    expect(getAutoAdvanceDeadlineMs({ mode: 'onTheMinute', anchorMs: T0, targetSeconds: 60, nowMs: T0 + 60_000 })).toBe(
      T0 + 120_000,
    );
  });

  it('returns null without an anchor or a target', () => {
    expect(getAutoAdvanceDeadlineMs({ mode: 'afterTick', anchorMs: null, targetSeconds: 60, nowMs: T0 })).toBeNull();
    expect(getAutoAdvanceDeadlineMs({ mode: 'afterTick', anchorMs: T0, targetSeconds: null, nowMs: T0 })).toBeNull();
    expect(getAutoAdvanceDeadlineMs({ mode: 'afterTick', anchorMs: T0, targetSeconds: 0, nowMs: T0 })).toBeNull();
  });
});

describe('shouldScheduleAutoAdvance', () => {
  const base = { targetSeconds: 60, autoAdvance: true, canDriveWall: true };

  it('schedules for an armed, running, driving climber', () => {
    expect(shouldScheduleAutoAdvance({ ...base, state: armedState() })).toBe(true);
  });

  it('does not schedule while disarmed', () => {
    expect(shouldScheduleAutoAdvance({ ...base, state: armedState({ armed: false }) })).toBe(false);
  });

  it('does not schedule while paused', () => {
    expect(shouldScheduleAutoAdvance({ ...base, state: armedState({ isRunning: false }) })).toBe(false);
  });

  it('does not schedule with auto-advance switched off', () => {
    expect(shouldScheduleAutoAdvance({ ...base, autoAdvance: false, state: armedState() })).toBe(false);
  });

  it('does not schedule for a passenger who is not driving the wall', () => {
    expect(shouldScheduleAutoAdvance({ ...base, canDriveWall: false, state: armedState() })).toBe(false);
  });

  it('does not schedule without a target', () => {
    expect(shouldScheduleAutoAdvance({ ...base, targetSeconds: null, state: armedState() })).toBe(false);
  });

  it('does not schedule without an anchor', () => {
    expect(shouldScheduleAutoAdvance({ ...base, state: armedState({ anchorMs: null }) })).toBe(false);
  });

  it('stops beating against an exhausted queue', () => {
    expect(shouldScheduleAutoAdvance({ ...base, state: armedState({ queueEnded: true }) })).toBe(false);
  });
});

describe('getRestTimerCycleElapsedSeconds', () => {
  const base = { targetSeconds: 60, isRunning: true, pausedElapsedSeconds: 0 };

  it('counts up from the tick in after-tick mode, past the target', () => {
    expect(getRestTimerCycleElapsedSeconds({ ...base, mode: 'afterTick', anchorMs: T0, nowMs: T0 + 95_000 })).toBe(95);
  });

  it('counts up from the last beat in on-the-minute mode', () => {
    expect(getRestTimerCycleElapsedSeconds({ ...base, mode: 'onTheMinute', anchorMs: T0, nowMs: T0 + 95_000 })).toBe(
      35,
    );
  });

  it('counts from the anchor in on-the-minute mode when no target is set', () => {
    expect(
      getRestTimerCycleElapsedSeconds({
        ...base,
        targetSeconds: null,
        mode: 'onTheMinute',
        anchorMs: T0,
        nowMs: T0 + 95_000,
      }),
    ).toBe(95);
  });

  it('reports the frozen value while paused', () => {
    expect(
      getRestTimerCycleElapsedSeconds({
        ...base,
        isRunning: false,
        pausedElapsedSeconds: 42,
        mode: 'afterTick',
        anchorMs: T0,
        nowMs: T0 + 999_000,
      }),
    ).toBe(42);
  });

  it('reports zero with no anchor', () => {
    expect(getRestTimerCycleElapsedSeconds({ ...base, mode: 'afterTick', anchorMs: null, nowMs: T0 })).toBe(0);
  });
});
