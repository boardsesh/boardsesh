// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { isWallDisplayOpen, markWallDisplayMounted, useWallDisplayOpen } from '../wall-display-presence';

describe('wall display presence', () => {
  it('reports the display open while any copy is mounted, and releases each copy once', () => {
    const { result } = renderHook(() => useWallDisplayOpen());
    expect(result.current).toBe(false);

    let releaseFirst = () => {};
    let releaseSecond = () => {};
    act(() => {
      releaseFirst = markWallDisplayMounted();
      releaseSecond = markWallDisplayMounted();
    });
    expect(result.current).toBe(true);

    act(() => {
      releaseFirst();
      releaseFirst();
    });
    // A double release cannot close a display that is still mounted.
    expect(isWallDisplayOpen()).toBe(true);

    act(() => {
      releaseSecond();
    });
    expect(result.current).toBe(false);
  });
});
