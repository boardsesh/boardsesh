import { describe, it, expect } from 'vitest';
import {
  computePeekOffset,
  decideSwipeDirection,
  evaluateSwipeOutcome,
  selectPeekDirection,
  getEnterDirection,
  computeSwipeExitTarget,
  SWIPE_OFFSCREEN_PAD,
  SWIPE_THRESHOLD,
  DIRECTION_THRESHOLD,
  VERTICAL_LOCK_RATIO,
} from '../swipe-carousel';

describe('computePeekOffset', () => {
  it('clamps the next-peek to 0 when finger has not moved', () => {
    expect(computePeekOffset({ direction: 'next', swipeOffset: 0, viewportWidth: 400 })).toBe(400);
  });

  it('slides the next-peek in from the right as the finger drags left', () => {
    expect(computePeekOffset({ direction: 'next', swipeOffset: -150, viewportWidth: 400 })).toBe(250);
  });

  it('never lets the next-peek overshoot past the viewport edge', () => {
    expect(computePeekOffset({ direction: 'next', swipeOffset: -800, viewportWidth: 400 })).toBe(0);
  });

  it('slides the prev-peek in from the left as the finger drags right', () => {
    expect(computePeekOffset({ direction: 'prev', swipeOffset: 150, viewportWidth: 400 })).toBe(-250);
  });

  it('never lets the prev-peek overshoot past the viewport edge', () => {
    expect(computePeekOffset({ direction: 'prev', swipeOffset: 800, viewportWidth: 400 })).toBe(0);
  });

  // Regression: before the viewport is measured (width 0) both peeks resolve to
  // translateX 0 — i.e. stacked directly on the current label. Consumers must not
  // render the peek slots until width > 0 (the `canPeek` guard in useQueueCarousel),
  // or the queue bar shows several climbs' text overlapping. See ClimbCapsule.
  it('collapses both peeks onto the current label when the viewport is unmeasured', () => {
    expect(computePeekOffset({ direction: 'next', swipeOffset: 0, viewportWidth: 0 })).toBe(0);
    expect(computePeekOffset({ direction: 'prev', swipeOffset: 0, viewportWidth: 0 })).toBe(0);
  });
});

describe('decideSwipeDirection', () => {
  it('returns null while neither axis exceeds the threshold', () => {
    expect(decideSwipeDirection(5, 5)).toBeNull();
    expect(decideSwipeDirection(DIRECTION_THRESHOLD, DIRECTION_THRESHOLD)).toBeNull();
  });

  it('locks to horizontal when |dx| dominates past the threshold', () => {
    expect(decideSwipeDirection(20, 5)).toBe('horizontal');
    expect(decideSwipeDirection(-25, 4)).toBe('horizontal');
  });

  it('locks to vertical when |dy| dominates past the threshold', () => {
    expect(decideSwipeDirection(5, 20)).toBe('vertical');
    expect(decideSwipeDirection(-3, -30)).toBe('vertical');
  });

  it('honours a custom threshold', () => {
    expect(decideSwipeDirection(25, 5, 30)).toBeNull();
    expect(decideSwipeDirection(40, 5, 30)).toBe('horizontal');
  });

  it('defaults to the symmetric rule (ties lock vertical) so web is unchanged', () => {
    expect(decideSwipeDirection(12, 12)).toBe('vertical');
    expect(decideSwipeDirection(12, 13)).toBe('vertical');
  });

  it('biases toward horizontal under a >1 ratio so a slightly-diagonal swipe locks horizontal', () => {
    // dx=10, dy=12 reads vertical with the symmetric default…
    expect(decideSwipeDirection(10, 12)).toBe('vertical');
    // …but horizontal once the vertical-lock bias applies (12 < 10 × 1.5).
    expect(decideSwipeDirection(10, 12, DIRECTION_THRESHOLD, VERTICAL_LOCK_RATIO)).toBe('horizontal');
  });

  it('still locks a clearly-vertical drag even under the horizontal bias', () => {
    // Genuine scroll/dismiss: near-vertical, so it clears absX × ratio easily.
    expect(decideSwipeDirection(5, 20, DIRECTION_THRESHOLD, VERTICAL_LOCK_RATIO)).toBe('vertical');
    expect(decideSwipeDirection(-4, -30, DIRECTION_THRESHOLD, VERTICAL_LOCK_RATIO)).toBe('vertical');
  });
});

describe('evaluateSwipeOutcome', () => {
  it('returns next when swipe-left exceeds threshold and canNext is true', () => {
    expect(evaluateSwipeOutcome({ deltaX: -100, canNext: true, canPrev: true })).toBe('next');
  });

  it('returns previous when swipe-right exceeds threshold and canPrev is true', () => {
    expect(evaluateSwipeOutcome({ deltaX: 100, canNext: true, canPrev: true })).toBe('previous');
  });

  it('cancels when threshold is not met', () => {
    expect(evaluateSwipeOutcome({ deltaX: -SWIPE_THRESHOLD + 1, canNext: true, canPrev: true })).toBe('cancel');
    expect(evaluateSwipeOutcome({ deltaX: SWIPE_THRESHOLD - 1, canNext: true, canPrev: true })).toBe('cancel');
  });

  it('cancels when navigation in the requested direction is blocked', () => {
    expect(evaluateSwipeOutcome({ deltaX: -200, canNext: false, canPrev: true })).toBe('cancel');
    expect(evaluateSwipeOutcome({ deltaX: 200, canNext: true, canPrev: false })).toBe('cancel');
  });

  it('honours a custom threshold', () => {
    expect(evaluateSwipeOutcome({ deltaX: -50, canNext: true, canPrev: true, threshold: 40 })).toBe('next');
    expect(evaluateSwipeOutcome({ deltaX: -30, canNext: true, canPrev: true, threshold: 40 })).toBe('cancel');
  });
});

describe('selectPeekDirection', () => {
  it('locks to next when an exit-left animation is in flight', () => {
    expect(selectPeekDirection({ animationDirection: 'left', swipeOffset: 0 })).toBe('next');
  });

  it('locks to prev when an exit-right animation is in flight', () => {
    expect(selectPeekDirection({ animationDirection: 'right', swipeOffset: 0 })).toBe('prev');
  });

  it('falls back to the live offset sign during an active drag', () => {
    expect(selectPeekDirection({ animationDirection: null, swipeOffset: -10 })).toBe('next');
    expect(selectPeekDirection({ animationDirection: null, swipeOffset: 10 })).toBe('prev');
  });

  it('treats an idle gesture (offset 0) as previous', () => {
    expect(selectPeekDirection({ animationDirection: null, swipeOffset: 0 })).toBe('prev');
  });
});

describe('getEnterDirection', () => {
  it('maps next-navigation to from-right (new climb enters from the right)', () => {
    expect(getEnterDirection('next')).toBe('from-right');
  });

  it('maps previous-navigation to from-left', () => {
    expect(getEnterDirection('previous')).toBe('from-left');
  });
});

describe('computeSwipeExitTarget', () => {
  it('targets the screen width plus the off-screen pad', () => {
    expect(computeSwipeExitTarget(390)).toBe(390 + SWIPE_OFFSCREEN_PAD);
  });
});
