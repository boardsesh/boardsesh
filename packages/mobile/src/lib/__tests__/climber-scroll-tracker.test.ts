import { describe, expect, it, vi } from 'vitest';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { createClimberScrollTracker } from '../climber-scroll-tracker';

const scrollEvent = {
  nativeEvent: { contentOffset: { x: 0, y: 120 } },
} as unknown as NativeSyntheticEvent<NativeScrollEvent>;

describe('createClimberScrollTracker', () => {
  it('does not count a scroll with no drag or fling behind it', () => {
    const tracker = createClimberScrollTracker(() => undefined);
    tracker.handlers.onScroll(scrollEvent);
    expect(tracker.hasScrolled()).toBe(false);
  });

  it('counts a drag', () => {
    const tracker = createClimberScrollTracker(() => undefined);
    tracker.handlers.onScrollBeginDrag(scrollEvent);
    expect(tracker.hasScrolled()).toBe(true);
  });

  it('keeps counting a fling that is still coasting after a reset', () => {
    const tracker = createClimberScrollTracker(() => undefined);
    tracker.handlers.onScrollBeginDrag(scrollEvent);
    tracker.handlers.onScrollEndDrag(scrollEvent);
    tracker.handlers.onMomentumScrollBegin();
    tracker.reset();
    expect(tracker.hasScrolled()).toBe(false);
    tracker.handlers.onScroll(scrollEvent);
    expect(tracker.hasScrolled()).toBe(true);
  });

  // A slow, steady drag keeps paging because of this.
  it('keeps counting a drag that is still under way after a reset', () => {
    const tracker = createClimberScrollTracker(() => undefined);
    tracker.handlers.onScrollBeginDrag(scrollEvent);
    tracker.reset();
    expect(tracker.hasScrolled()).toBe(false);
    tracker.handlers.onScroll(scrollEvent);
    expect(tracker.hasScrolled()).toBe(true);
  });

  it('forgets a drag or fling whose end event will never come', () => {
    const tracker = createClimberScrollTracker(() => undefined);
    tracker.handlers.onScrollBeginDrag(scrollEvent);
    tracker.handlers.onMomentumScrollBegin();
    tracker.forgetGesture();
    expect(tracker.hasScrolled()).toBe(false);
    tracker.handlers.onScroll(scrollEvent);
    expect(tracker.hasScrolled()).toBe(false);
  });

  it('stops counting once the fling has stopped', () => {
    const tracker = createClimberScrollTracker(() => undefined);
    tracker.handlers.onMomentumScrollBegin();
    tracker.handlers.onMomentumScrollEnd();
    tracker.reset();
    tracker.handlers.onScroll(scrollEvent);
    expect(tracker.hasScrolled()).toBe(false);
  });

  it('forwards every event to the handlers it wraps, read at event time', () => {
    const first = { onScroll: vi.fn() };
    const second = { onScroll: vi.fn(), onScrollBeginDrag: vi.fn(), onMomentumScrollEnd: vi.fn() };
    let forward: typeof first | typeof second = first;
    const tracker = createClimberScrollTracker(() => forward);
    tracker.handlers.onScroll(scrollEvent);
    forward = second;
    tracker.handlers.onScroll(scrollEvent);
    tracker.handlers.onScrollBeginDrag(scrollEvent);
    tracker.handlers.onMomentumScrollEnd();
    expect(first.onScroll).toHaveBeenCalledTimes(1);
    expect(second.onScroll).toHaveBeenCalledTimes(1);
    expect(second.onScrollBeginDrag).toHaveBeenCalledWith(scrollEvent);
    expect(second.onMomentumScrollEnd).toHaveBeenCalledTimes(1);
  });
});
