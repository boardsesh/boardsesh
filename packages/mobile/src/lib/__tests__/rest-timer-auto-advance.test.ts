import { describe, expect, it } from 'vitest';
import {
  AUTO_ADVANCE_MAX_BACKDATE_MS,
  AUTO_ADVANCE_OVERDUE_GRACE_MS,
  AUTO_ADVANCE_REST_FLOOR_SLACK_MS,
  getAfterTickRestFloorMs,
  getAutoAdvanceDeadlineMs,
  isAutoAdvanceDeadlineStale,
  getRestTimerCycleElapsedSeconds,
  isTickFreshEnoughToArm,
  shouldScheduleAutoAdvance,
} from '../rest-timer-auto-advance';
import type { RestTimerState } from '../rest-timer-store';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');

const armedState = (overrides: Partial<RestTimerState> = {}): RestTimerState => ({
  armed: true,
  armedForSessionId: 'session-1',
  crew: null,
  crewPacingDraft: null,
  anchorMs: T0,
  isRunning: true,
  pausedElapsedSeconds: 0,
  cycleId: 1,
  lastTickAt: null,
  queueEnded: false,
  listEnded: false,
  lastFiredDeadlineMs: null,
  crewBeatSkippedMs: null,
  stagePacing: null,
  lastTick: null,
  advancedFromQueueItemUuid: null,
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

  it('reports a paused rest past its target whole in after-tick mode, so it still reads as over', () => {
    expect(
      getRestTimerCycleElapsedSeconds({
        ...base,
        isRunning: false,
        pausedElapsedSeconds: 95,
        mode: 'afterTick',
        anchorMs: T0,
        nowMs: T0 + 999_000,
      }),
    ).toBe(95);
  });

  it('reports a paused on-the-minute rest within its window, never past the target', () => {
    const paused = { ...base, isRunning: false, mode: 'onTheMinute' as const, anchorMs: T0, nowMs: T0 + 999_000 };
    expect(getRestTimerCycleElapsedSeconds({ ...paused, pausedElapsedSeconds: 230 })).toBe(50);
    expect(getRestTimerCycleElapsedSeconds({ ...paused, pausedElapsedSeconds: 42 })).toBe(42);
    expect(getRestTimerCycleElapsedSeconds({ ...paused, pausedElapsedSeconds: 240 })).toBe(0);
    // The same number the running clock shows at that instant.
    expect(getRestTimerCycleElapsedSeconds({ ...base, mode: 'onTheMinute', anchorMs: T0, nowMs: T0 + 230_000 })).toBe(
      50,
    );
  });

  it('reports a paused on-the-minute rest whole when no target is set', () => {
    expect(
      getRestTimerCycleElapsedSeconds({
        ...base,
        targetSeconds: null,
        isRunning: false,
        pausedElapsedSeconds: 230,
        mode: 'onTheMinute',
        anchorMs: T0,
        nowMs: T0 + 999_000,
      }),
    ).toBe(230);
  });

  it('reports zero with no anchor', () => {
    expect(getRestTimerCycleElapsedSeconds({ ...base, mode: 'afterTick', anchorMs: null, nowMs: T0 })).toBe(0);
  });
});

describe('a beat that already fired', () => {
  it('is never scheduled again when the wall clock steps backwards', () => {
    // RN's timer queue runs on a monotonic clock while the deadline is derived
    // from Date.now(). An NTP step back of a millisecond used to hand back the
    // beat we just fired, and the fresh cycle id waved the second advance
    // through — two climbs skipped, the wall lit for the wrong one.
    const fired = T0 + 60_000;
    const deadline = getAutoAdvanceDeadlineMs({
      mode: 'onTheMinute',
      anchorMs: T0,
      targetSeconds: 60,
      nowMs: fired - 1,
      lastFiredDeadlineMs: fired,
    });
    expect(deadline).toBe(T0 + 120_000);
  });

  it('keeps the cadence phase when it walks forward', () => {
    const deadline = getAutoAdvanceDeadlineMs({
      mode: 'onTheMinute',
      anchorMs: T0,
      targetSeconds: 60,
      nowMs: T0 + 10,
      lastFiredDeadlineMs: T0 + 300_000,
    });
    // Still on the anchor's minute grid, just past everything already fired.
    expect((deadline! - T0) % 60_000).toBe(0);
    expect(deadline).toBeGreaterThan(T0 + 300_000);
  });

  it('leaves an ordinary next beat alone', () => {
    expect(
      getAutoAdvanceDeadlineMs({
        mode: 'onTheMinute',
        anchorMs: T0,
        targetSeconds: 60,
        nowMs: T0 + 61_000,
        lastFiredDeadlineMs: T0 + 60_000,
      }),
    ).toBe(T0 + 120_000);
  });
});

describe('the after-tick rest floor', () => {
  // The last advance, B. A 90 s rest.
  const B = T0 + 600_000;
  const afterTick = (anchorMs: number, nowMs: number, targetSeconds = 90, lastFiredDeadlineMs: number | null = B) => ({
    mode: 'afterTick' as const,
    anchorMs,
    targetSeconds,
    nowMs,
    lastFiredDeadlineMs,
  });

  it('counts a running rest that began 83 s before the advance from 3 s before it', () => {
    // A send from 85 s ago, logged 2 s after the advance: its own rest ends at B + 7 s.
    expect(getAfterTickRestFloorMs(afterTick(B - 83_000, B + 2_000))).toBe(B - AUTO_ADVANCE_REST_FLOOR_SLACK_MS);
    expect(getAutoAdvanceDeadlineMs(afterTick(B - 83_000, B + 2_000))).toBe(B + 87_000);
  });

  it('leaves a rest that has already run out as it was: past, so nothing is scheduled', () => {
    // A send from 5 min ago: its own rest ran out 3:28 before the advance.
    expect(getAfterTickRestFloorMs(afterTick(B - 298_000, B + 2_000))).toBeNull();
    expect(getAutoAdvanceDeadlineMs(afterTick(B - 298_000, B + 2_000))).toBe(B - 208_000);
    // One that ran out a moment ago is past too, never revived.
    expect(getAutoAdvanceDeadlineMs(afterTick(B - 83_000, B + 7_000))).toBe(B + 7_000);
  });

  it('floors a rest lengthened back to life in the settings', () => {
    // The same 5 min-old anchor on 5:10 now ends at B + 12 s, 2 s from now.
    expect(getAutoAdvanceDeadlineMs(afterTick(B - 298_000, B + 10_000, 310))).toBe(B + 307_000);
    // On 5:00 it ended at B + 2 s, already gone: still past.
    expect(getAutoAdvanceDeadlineMs(afterTick(B - 298_000, B + 10_000, 300))).toBe(B + 2_000);
  });

  it('leaves an ordinary rest alone: the fire’s own re-anchor, one up to 3 s early, and one after it', () => {
    expect(getAutoAdvanceDeadlineMs(afterTick(B, B))).toBe(B + 90_000);
    expect(getAutoAdvanceDeadlineMs(afterTick(B - 3_000, B))).toBe(B + 87_000);
    expect(getAfterTickRestFloorMs(afterTick(B - 3_000, B))).toBeNull();
    expect(getAutoAdvanceDeadlineMs(afterTick(B + 20_000, B + 20_000))).toBe(B + 110_000);
  });

  it('takes the stage changeover as the rest: 10 s from the advance, less the slack', () => {
    expect(getAutoAdvanceDeadlineMs(afterTick(B - 5_000, B + 1_000, 10))).toBe(B + 7_000);
    expect(getAutoAdvanceDeadlineMs(afterTick(B + 1_000, B + 1_000, 10))).toBe(B + 11_000);
    // A changeover that ran out before the advance stays run out.
    expect(getAutoAdvanceDeadlineMs(afterTick(B - 20_000, B + 1_000, 10))).toBe(B - 10_000);
  });

  it('does nothing without a last advance, or on the minute', () => {
    expect(getAutoAdvanceDeadlineMs(afterTick(B - 83_000, B + 2_000, 90, null))).toBe(B + 7_000);
    expect(getAfterTickRestFloorMs({ ...afterTick(B - 83_000, B + 2_000), mode: 'onTheMinute' })).toBeNull();
  });

  it('never hands back a deadline still ahead that is less than a rest after the advance, less the slack', () => {
    for (const targetSeconds of [10, 30, 90, 180, 310]) {
      for (let anchorOffsetMs = -400_000; anchorOffsetMs <= 20_000; anchorOffsetMs += 1_000) {
        for (let nowOffsetMs = 0; nowOffsetMs <= 400_000; nowOffsetMs += 10_000) {
          const nowMs = B + nowOffsetMs;
          const deadlineMs = getAutoAdvanceDeadlineMs(afterTick(B + anchorOffsetMs, nowMs, targetSeconds));
          const ownDeadlineMs = B + anchorOffsetMs + targetSeconds * 1000;
          if (deadlineMs === null) throw new Error('an anchored rest always has a deadline');
          if (deadlineMs > nowMs) {
            expect(deadlineMs).toBeGreaterThanOrEqual(B + targetSeconds * 1000 - AUTO_ADVANCE_REST_FLOOR_SLACK_MS);
          }
          // It only ever delays: a deadline the anchor alone puts in the past stays there.
          if (ownDeadlineMs <= nowMs) expect(deadlineMs).toBe(ownDeadlineMs);
          else expect(deadlineMs).toBeGreaterThanOrEqual(ownDeadlineMs);
        }
      }
    }
  });
});

describe('isAutoAdvanceDeadlineStale', () => {
  it('accepts a deadline that has only just come due', () => {
    expect(isAutoAdvanceDeadlineStale(T0, T0)).toBe(false);
    expect(isAutoAdvanceDeadlineStale(T0, T0 + AUTO_ADVANCE_OVERDUE_GRACE_MS)).toBe(false);
  });

  it('rejects one the app slept through', () => {
    expect(isAutoAdvanceDeadlineStale(T0, T0 + AUTO_ADVANCE_OVERDUE_GRACE_MS + 1)).toBe(true);
    expect(isAutoAdvanceDeadlineStale(T0, T0 + 600_000)).toBe(true);
  });

  it('treats no deadline as not stale', () => {
    expect(isAutoAdvanceDeadlineStale(null, T0)).toBe(false);
  });
});
