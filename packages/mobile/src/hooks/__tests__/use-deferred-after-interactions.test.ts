// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Controllable idle scheduler: the test decides whether (and when) a
// scheduled callback ever runs, so it can simulate a STARVED idle queue
// (the production stall this hook guards against).
const { scheduled, scheduleIdleTask } = vi.hoisted(() => {
  const scheduled: Array<() => void> = [];
  return {
    scheduled,
    scheduleIdleTask: vi.fn((callback: () => void) => {
      scheduled.push(callback);
      return { cancel: vi.fn() };
    }),
  };
});

vi.mock('../../lib/schedule-idle-task', () => ({ scheduleIdleTask }));

import { useDeferredAfterInteractions } from '../use-deferred-after-interactions';

function flushInteractions() {
  for (const callback of scheduled.splice(0)) callback();
}

describe('useDeferredAfterInteractions', () => {
  beforeEach(() => {
    scheduled.length = 0;
    scheduleIdleTask.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false until idle callback runs, then true', () => {
    const { result } = renderHook(() => useDeferredAfterInteractions(true));
    expect(result.current).toBe(false);
    act(() => flushInteractions());
    expect(result.current).toBe(true);
  });

  it('falls back to true after the timeout if scheduleIdleTask never fires (the stall bug)', () => {
    const { result } = renderHook(() => useDeferredAfterInteractions(true, undefined, 350));
    expect(result.current).toBe(false);
    // Never flush the idle queue — simulate a starved queue.
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(result.current).toBe(true);
  });

  it('stays false while inactive', () => {
    const { result } = renderHook(() => useDeferredAfterInteractions(false));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(false);
  });

  it('re-defers when resetKey changes', () => {
    const { result, rerender } = renderHook(({ key }) => useDeferredAfterInteractions(true, key), {
      initialProps: { key: 'a' },
    });
    act(() => flushInteractions());
    expect(result.current).toBe(true);

    rerender({ key: 'b' });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(result.current).toBe(true);
  });

  it('only applies once when both the interaction callback and the timeout fire', () => {
    const { result } = renderHook(() => useDeferredAfterInteractions(true, undefined, 350));
    act(() => {
      flushInteractions();
      vi.advanceTimersByTime(350);
    });
    expect(result.current).toBe(true);
  });
});
