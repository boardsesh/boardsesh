// The final countdown's pure rules (#5396): how long it runs, when its cues are
// due, when a cue is too late to play, and the instant a rest runs out with
// nothing moving the wall.
import { describe, expect, it } from 'vitest';
import {
  AUTO_ADVANCE_OVERDUE_GRACE_MS,
  REST_TIMER_CUE_LATE_MS,
  getMsUntilNextRestTimerSecond,
  getRestTimerCountdownCueTimes,
  getRestTimerCountdownLeadSeconds,
  getRestTimerReachedAtMs,
  isRestTimerCueLate,
  isRestTimerFinalCountdown,
  isRestTimerReachedCueLate,
} from '../rest-timer-auto-advance';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');

describe('getRestTimerCountdownLeadSeconds', () => {
  it.each([
    { targetSeconds: 10, leadSeconds: 3 },
    { targetSeconds: 30, leadSeconds: 3 },
    { targetSeconds: 60, leadSeconds: 3 },
    { targetSeconds: 61, leadSeconds: 4 },
    { targetSeconds: 179, leadSeconds: 4 },
    { targetSeconds: 180, leadSeconds: 5 },
    { targetSeconds: 600, leadSeconds: 5 },
  ])('counts the last $leadSeconds s of a $targetSeconds s rest', ({ targetSeconds, leadSeconds }) => {
    expect(getRestTimerCountdownLeadSeconds(targetSeconds)).toBe(leadSeconds);
  });

  it('never covers the whole rest', () => {
    expect(getRestTimerCountdownLeadSeconds(4)).toBe(3);
    expect(getRestTimerCountdownLeadSeconds(3)).toBe(2);
    expect(getRestTimerCountdownLeadSeconds(1)).toBe(0);
  });

  it('has nothing to count down to with no rest set', () => {
    expect(getRestTimerCountdownLeadSeconds(null)).toBe(0);
    expect(getRestTimerCountdownLeadSeconds(0)).toBe(0);
    expect(getRestTimerCountdownLeadSeconds(-5)).toBe(0);
  });
});

describe('getRestTimerCountdownCueTimes', () => {
  it('puts one cue on each whole second of the lead, earliest first', () => {
    expect(getRestTimerCountdownCueTimes(T0 + 60_000, 3)).toEqual([
      { atMs: T0 + 57_000, secondsLeft: 3 },
      { atMs: T0 + 58_000, secondsLeft: 2 },
      { atMs: T0 + 59_000, secondsLeft: 1 },
    ]);
  });

  it('puts none down with no lead', () => {
    expect(getRestTimerCountdownCueTimes(T0, 0)).toEqual([]);
  });

  it('never asks for more than five', () => {
    expect(getRestTimerCountdownCueTimes(T0, getRestTimerCountdownLeadSeconds(3600))).toHaveLength(5);
  });
});

describe('isRestTimerCueLate', () => {
  it('plays a cue a little behind its instant and drops one flushed on resume', () => {
    expect(isRestTimerCueLate(T0, T0)).toBe(false);
    expect(isRestTimerCueLate(T0, T0 + REST_TIMER_CUE_LATE_MS)).toBe(false);
    expect(isRestTimerCueLate(T0, T0 + REST_TIMER_CUE_LATE_MS + 1)).toBe(true);
    expect(isRestTimerCueLate(T0, T0 + 60_000)).toBe(true);
  });
});

describe('isRestTimerReachedCueLate', () => {
  it('gives the rest end the advance grace, not the countdown cutoff', () => {
    expect(isRestTimerReachedCueLate(T0, T0 + REST_TIMER_CUE_LATE_MS + 1)).toBe(false);
    expect(isRestTimerReachedCueLate(T0, T0 + AUTO_ADVANCE_OVERDUE_GRACE_MS)).toBe(false);
    expect(isRestTimerReachedCueLate(T0, T0 + AUTO_ADVANCE_OVERDUE_GRACE_MS + 1)).toBe(true);
  });
});

describe('isRestTimerFinalCountdown', () => {
  it('covers the lead through 0:00, not the seconds before it or the overrun after', () => {
    expect(isRestTimerFinalCountdown(4, 3)).toBe(false);
    expect(isRestTimerFinalCountdown(3, 3)).toBe(true);
    expect(isRestTimerFinalCountdown(1, 3)).toBe(true);
    expect(isRestTimerFinalCountdown(0, 3)).toBe(true);
    expect(isRestTimerFinalCountdown(-1, 3)).toBe(false);
  });

  it('is never on without a rest to count down to', () => {
    expect(isRestTimerFinalCountdown(null, 3)).toBe(false);
    expect(isRestTimerFinalCountdown(0, 0)).toBe(false);
  });
});

describe('getMsUntilNextRestTimerSecond', () => {
  it('waits to the anchor’s next whole second, not a flat second from now', () => {
    expect(getMsUntilNextRestTimerSecond(T0 + 400, T0 + 1_000)).toBe(400);
    expect(getMsUntilNextRestTimerSecond(T0, T0 + 1_999)).toBe(1);
  });

  it('waits a whole second when it is already on one', () => {
    expect(getMsUntilNextRestTimerSecond(T0, T0 + 57_000)).toBe(1000);
  });

  it('handles an anchor still ahead of the clock', () => {
    expect(getMsUntilNextRestTimerSecond(T0 + 2_250, T0)).toBe(250);
  });

  it('falls back to a plain second with nothing to align to', () => {
    expect(getMsUntilNextRestTimerSecond(null, T0 + 123)).toBe(1000);
  });
});

describe('getRestTimerReachedAtMs', () => {
  const afterTick = { mode: 'afterTick' as const, anchorMs: T0, targetSeconds: 60, handledThroughMs: null };
  const onTheMinute = { mode: 'onTheMinute' as const, anchorMs: T0, targetSeconds: 60, handledThroughMs: null };

  it('is the end of the rest after a tick', () => {
    expect(getRestTimerReachedAtMs({ ...afterTick, nowMs: T0 + 10_000 })).toBe(T0 + 60_000);
  });

  it('still names a rest that ended a moment ago without a cue, so a dead end gets one', () => {
    expect(getRestTimerReachedAtMs({ ...afterTick, nowMs: T0 + 60_000 })).toBe(T0 + 60_000);
    expect(getRestTimerReachedAtMs({ ...afterTick, nowMs: T0 + 61_500 })).toBe(T0 + 60_000);
    expect(getRestTimerReachedAtMs({ ...afterTick, nowMs: T0 + 60_000 + AUTO_ADVANCE_OVERDUE_GRACE_MS })).toBe(
      T0 + 60_000,
    );
  });

  it('lets a rest that ended past the advance grace go silent', () => {
    expect(
      getRestTimerReachedAtMs({ ...afterTick, nowMs: T0 + 60_000 + AUTO_ADVANCE_OVERDUE_GRACE_MS + 1 }),
    ).toBeNull();
  });

  it('never names an instant twice', () => {
    expect(getRestTimerReachedAtMs({ ...afterTick, nowMs: T0 + 60_000, handledThroughMs: T0 + 60_000 })).toBeNull();
  });

  it('names the new mark when the rest is lengthened after the old one was cued', () => {
    expect(
      getRestTimerReachedAtMs({ ...afterTick, targetSeconds: 300, nowMs: T0 + 90_000, handledThroughMs: T0 + 60_000 }),
    ).toBe(T0 + 300_000);
  });

  it('comes round every beat on the minute', () => {
    expect(getRestTimerReachedAtMs({ ...onTheMinute, nowMs: T0 + 10_000 })).toBe(T0 + 60_000);
    expect(getRestTimerReachedAtMs({ ...onTheMinute, nowMs: T0 + 60_000, handledThroughMs: T0 + 60_000 })).toBe(
      T0 + 120_000,
    );
    expect(getRestTimerReachedAtMs({ ...onTheMinute, nowMs: T0 + 130_000, handledThroughMs: T0 + 120_000 })).toBe(
      T0 + 180_000,
    );
  });

  it('names a beat that just went without a cue, and skips one an advance already fired on', () => {
    expect(getRestTimerReachedAtMs({ ...onTheMinute, nowMs: T0 + 60_200 })).toBe(T0 + 60_000);
    expect(getRestTimerReachedAtMs({ ...onTheMinute, nowMs: T0 + 61_500 })).toBe(T0 + 60_000);
    expect(getRestTimerReachedAtMs({ ...onTheMinute, nowMs: T0 + 66_000 })).toBe(T0 + 120_000);
    expect(getRestTimerReachedAtMs({ ...onTheMinute, nowMs: T0 + 60_200, handledThroughMs: T0 + 60_000 })).toBe(
      T0 + 120_000,
    );
  });

  it('moves on to the next beat when the cue landed a hair early', () => {
    // The cue for the 1:00 beat ran a millisecond before the clock reached it.
    expect(getRestTimerReachedAtMs({ ...onTheMinute, nowMs: T0 + 59_999, handledThroughMs: T0 + 60_000 })).toBe(
      T0 + 120_000,
    );
  });

  it('has nothing to name with no anchor or no rest', () => {
    expect(getRestTimerReachedAtMs({ ...afterTick, anchorMs: null, nowMs: T0 })).toBeNull();
    expect(getRestTimerReachedAtMs({ ...onTheMinute, targetSeconds: null, nowMs: T0 })).toBeNull();
    expect(getRestTimerReachedAtMs({ ...onTheMinute, targetSeconds: 0, nowMs: T0 })).toBeNull();
  });
});
