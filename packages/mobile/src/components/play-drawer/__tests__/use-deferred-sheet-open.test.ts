// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDeferredSheetOpen } from '../use-deferred-sheet-open';

const FALLBACK_MS = 400;

describe('useDeferredSheetOpen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens immediately when no dismissal is in flight', () => {
    const openNow = vi.fn();
    const { result } = renderHook(() => useDeferredSheetOpen(openNow, FALLBACK_MS));
    act(() => result.current.requestOpen('climb-a'));
    expect(openNow).toHaveBeenCalledExactlyOnceWith('climb-a');
  });

  it('defers an open requested mid-dismiss and replays it from onDismiss', () => {
    const openNow = vi.fn();
    const { result } = renderHook(() => useDeferredSheetOpen(openNow, FALLBACK_MS));
    act(() => result.current.onAnimate(-1)); // dismiss animation starts
    act(() => result.current.requestOpen('climb-b'));
    expect(openNow).not.toHaveBeenCalled();
    act(() => result.current.flushOnDismiss());
    expect(openNow).toHaveBeenCalledExactlyOnceWith('climb-b');
    // The fallback timer must not fire a second open afterward.
    act(() => vi.advanceTimersByTime(FALLBACK_MS));
    expect(openNow).toHaveBeenCalledTimes(1);
  });

  it('replays the deferred open via the fallback timer when onDismiss never fires', () => {
    const openNow = vi.fn();
    const { result } = renderHook(() => useDeferredSheetOpen(openNow, FALLBACK_MS));
    act(() => result.current.onAnimate(-1));
    act(() => result.current.requestOpen('climb-b'));
    expect(openNow).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(FALLBACK_MS)); // gorhom skipped onDismiss
    expect(openNow).toHaveBeenCalledExactlyOnceWith('climb-b');
  });

  it('replays through the latest openNow, not the closure captured at schedule time', () => {
    const firstOpenNow = vi.fn();
    const secondOpenNow = vi.fn();
    const { result, rerender } = renderHook(({ openNow }) => useDeferredSheetOpen(openNow, FALLBACK_MS), {
      initialProps: { openNow: firstOpenNow },
    });
    act(() => result.current.onAnimate(-1));
    act(() => result.current.requestOpen('climb-b'));
    // State changed during the dismiss window → a fresh openNow identity.
    rerender({ openNow: secondOpenNow });
    act(() => vi.advanceTimersByTime(FALLBACK_MS));
    expect(firstOpenNow).not.toHaveBeenCalled();
    expect(secondOpenNow).toHaveBeenCalledExactlyOnceWith('climb-b');
  });

  it('drops a deferred open when the close is aborted (sheet springs back)', () => {
    const openNow = vi.fn();
    const { result } = renderHook(() => useDeferredSheetOpen(openNow, FALLBACK_MS));
    act(() => result.current.onAnimate(-1)); // close starts
    act(() => result.current.requestOpen('climb-b')); // stashed + fallback armed
    act(() => result.current.onAnimate(0)); // close aborted — springs back
    act(() => vi.advanceTimersByTime(FALLBACK_MS));
    expect(openNow).not.toHaveBeenCalled();
    // A later, unrelated close must not replay the dropped open either.
    act(() => result.current.flushOnDismiss());
    expect(openNow).not.toHaveBeenCalled();
  });

  it('replays a falsy stashed value (generic OpenArgs may be falsy)', () => {
    const openNow = vi.fn();
    const { result } = renderHook(() => useDeferredSheetOpen<number>(openNow, FALLBACK_MS));
    act(() => result.current.onAnimate(-1));
    act(() => result.current.requestOpen(0)); // 0 is a valid, falsy OpenArgs
    act(() => result.current.flushOnDismiss());
    expect(openNow).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('clears the fallback timer on unmount', () => {
    const openNow = vi.fn();
    const { result, unmount } = renderHook(() => useDeferredSheetOpen(openNow, FALLBACK_MS));
    act(() => result.current.onAnimate(-1));
    act(() => result.current.requestOpen('climb-b'));
    unmount();
    act(() => vi.advanceTimersByTime(FALLBACK_MS));
    expect(openNow).not.toHaveBeenCalled();
  });
});
