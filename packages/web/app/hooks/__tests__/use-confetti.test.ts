import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockConfetti } = vi.hoisted(() => ({ mockConfetti: vi.fn() }));
vi.mock('canvas-confetti', () => ({ default: mockConfetti }));

import { useConfetti } from '../use-confetti';

describe('useConfetti', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a stable callable function across re-renders', () => {
    const { result, rerender } = renderHook(() => useConfetti());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('fires confetti from the default position (0.5, 0.9) when called with no argument', () => {
    const { result } = renderHook(() => useConfetti());

    act(() => { result.current(); });

    expect(mockConfetti).toHaveBeenCalledTimes(1);
    const { origin } = mockConfetti.mock.calls[0][0] as { origin: { x: number; y: number } };
    expect(origin.x).toBe(0.5);
    expect(origin.y).toBe(0.9);
  });

  it('fires confetti from the default position when called with null', () => {
    const { result } = renderHook(() => useConfetti());

    act(() => { result.current(null); });

    expect(mockConfetti).toHaveBeenCalledTimes(1);
    const { origin } = mockConfetti.mock.calls[0][0] as { origin: { x: number; y: number } };
    expect(origin.x).toBe(0.5);
    expect(origin.y).toBe(0.9);
  });

  it('normalises the origin to the element centre relative to the viewport', () => {
    // Element: 80×40 at (100, 200), viewport: 400×800
    const el = document.createElement('button');
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 200, width: 80, height: 40,
      right: 180, bottom: 240, x: 100, y: 200,
      toJSON: vi.fn(),
    });
    Object.defineProperty(window, 'innerWidth',  { value: 400, writable: true, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, writable: true, configurable: true });

    const { result } = renderHook(() => useConfetti());

    act(() => { result.current(el); });

    expect(mockConfetti).toHaveBeenCalledTimes(1);
    const { origin } = mockConfetti.mock.calls[0][0] as { origin: { x: number; y: number } };
    // x = (100 + 40) / 400 = 0.35,  y = (200 + 20) / 800 = 0.275
    expect(origin.x).toBeCloseTo(0.35);
    expect(origin.y).toBeCloseTo(0.275);
  });

  it('always passes disableForReducedMotion: true', () => {
    const { result } = renderHook(() => useConfetti());

    act(() => { result.current(); });

    const opts = mockConfetti.mock.calls[0][0] as { disableForReducedMotion: boolean };
    expect(opts.disableForReducedMotion).toBe(true);
  });
});
