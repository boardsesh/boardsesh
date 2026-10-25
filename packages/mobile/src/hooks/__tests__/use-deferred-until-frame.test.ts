// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, render, act } from '@testing-library/react';
import { createElement } from 'react';

// Controllable requestAnimationFrame: the test decides when the scheduled frame
// runs, and tracks cancellations so unmount/inactive cleanup is observable. A
// rAF can't be starved, so — unlike the idle scheduler gate — there's no
// fallback timer to exercise.
const rafTasks: Array<{ id: number; run: FrameRequestCallback }> = [];
const cancelledIds = new Set<number>();
let nextRafId = 1;
const requestFrame = vi.fn((callback: FrameRequestCallback): number => {
  const id = nextRafId++;
  rafTasks.push({ id, run: callback });
  return id;
});
const cancelFrame = vi.fn((id: number) => {
  cancelledIds.add(id);
});

import { useDeferredUntilFrame } from '../use-deferred-until-frame';

function flushFrame() {
  act(() => {
    for (const task of rafTasks.splice(0)) {
      if (!cancelledIds.has(task.id)) task.run(performance.now());
    }
  });
}

describe('useDeferredUntilFrame', () => {
  beforeEach(() => {
    rafTasks.length = 0;
    cancelledIds.clear();
    nextRafId = 1;
    requestFrame.mockClear();
    cancelFrame.mockClear();
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
  });

  it('returns false until the next frame, then true', () => {
    const { result } = renderHook(() => useDeferredUntilFrame(true));
    expect(result.current).toBe(false);
    expect(requestFrame).toHaveBeenCalledTimes(1);

    flushFrame();
    expect(result.current).toBe(true);
  });

  it('is ready on the FIRST render in screenshot mode (before effects, no frame gate)', () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    // Probe records the hook's value during render — before any effect commits —
    // so this catches a lazy-init miss that an effect-driven setReady would hide
    // (act() flushing effects would make an effect-only path look ready too).
    const renderValues: boolean[] = [];
    function Probe() {
      renderValues.push(useDeferredUntilFrame(true));
      return null;
    }
    render(createElement(Probe));

    // The very first recorded render is already ready (seeded by the lazy init),
    // and nothing scheduled a frame.
    expect(renderValues[0]).toBe(true);
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('stays false while inactive and never schedules a frame', () => {
    const { result } = renderHook(() => useDeferredUntilFrame(false));
    expect(result.current).toBe(false);
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('resets to false when active goes back to false', () => {
    const { result, rerender } = renderHook(({ active }) => useDeferredUntilFrame(active), {
      initialProps: { active: true },
    });
    flushFrame();
    expect(result.current).toBe(true);

    rerender({ active: false });
    expect(result.current).toBe(false);
  });

  it('cancels the pending frame on unmount', () => {
    const { unmount } = renderHook(() => useDeferredUntilFrame(true));
    expect(requestFrame).toHaveBeenCalledTimes(1);

    unmount();
    expect(cancelFrame).toHaveBeenCalledTimes(1);
  });
});
