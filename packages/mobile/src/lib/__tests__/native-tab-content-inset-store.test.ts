// @vitest-environment jsdom
import { beforeEach, describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  publishNativeTabContentInsetBottom,
  publishNativeTabContentInsetSides,
  resetNativeTabContentInsetForTests,
  useNativeTabContentInsetBottom,
  useNativeTabContentInsetLeft,
  useNativeTabContentInsetPublishCount,
  useNativeTabContentInsetRight,
  useNativeTabContentInsetSideAtLeast,
} from '../native-tab-content-inset-store';

describe('native-tab-content-inset-store', () => {
  beforeEach(() => {
    resetNativeTabContentInsetForTests();
  });

  it('starts with no measurement', () => {
    const { result } = renderHook(() => useNativeTabContentInsetBottom());
    expect(result.current).toBeNull();
  });

  it('publishes a measurement to subscribers', () => {
    const { result } = renderHook(() => useNativeTabContentInsetBottom());
    act(() => publishNativeTabContentInsetBottom(83));
    expect(result.current).toBe(83);
    act(() => publishNativeTabContentInsetBottom(139));
    expect(result.current).toBe(139);
  });

  it('ignores sub-half-pixel jitter but accepts real changes', () => {
    const { result } = renderHook(() => useNativeTabContentInsetBottom());
    const { result: publishCount } = renderHook(() => useNativeTabContentInsetPublishCount());
    act(() => publishNativeTabContentInsetBottom(83));
    act(() => publishNativeTabContentInsetBottom(83.4));
    expect(result.current).toBe(83);
    expect(publishCount.current).toBe(1);
    act(() => publishNativeTabContentInsetBottom(83.5));
    expect(result.current).toBe(83.5);
    expect(publishCount.current).toBe(2);
  });

  it('accepts the first publish even when it matches a jitter of null', () => {
    // The epsilon only compares against a PREVIOUS measurement — the first
    // publish must always land, including 0 (a home-button device in-tab inset
    // with the bar hidden would be unusual, but the store must not drop it).
    const { result } = renderHook(() => useNativeTabContentInsetBottom());
    act(() => publishNativeTabContentInsetBottom(0));
    expect(result.current).toBe(0);
  });

  it('carries the side inset apart from the bottom one, as a threshold answer', () => {
    // INFERRED from a simulator log: a tab on iPhone Duo's inner display in
    // landscape read { right: 84, bottom: 34 } with the side rail.
    const { result: reached } = renderHook(() => useNativeTabContentInsetSideAtLeast(20));
    const { result: bottom } = renderHook(() => useNativeTabContentInsetBottom());
    const { result: publishCount } = renderHook(() => useNativeTabContentInsetPublishCount());
    expect(reached.current).toBe(false);
    act(() => publishNativeTabContentInsetSides(0, 84));
    expect(reached.current).toBe(true);
    expect(bottom.current).toBeNull();
    // The diagnostic counter tracks bottom publishes only.
    expect(publishCount.current).toBe(0);
    act(() => resetNativeTabContentInsetForTests());
    expect(reached.current).toBe(false);
  });

  it("re-renders a threshold reader only when the answer flips, not on an iPhone's first 0", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useNativeTabContentInsetSideAtLeast(20);
    });
    const rendersBefore = renders;
    act(() => publishNativeTabContentInsetSides(0, 0));
    act(() => publishNativeTabContentInsetSides(12, 0));
    expect(result.current).toBe(false);
    expect(renders).toBe(rendersBefore);
    act(() => publishNativeTabContentInsetSides(0, 84));
    expect(result.current).toBe(true);
    expect(renders).toBe(rendersBefore + 1);
    act(() => publishNativeTabContentInsetSides(0, 90));
    expect(renders).toBe(rendersBefore + 1);
  });

  it('resets to the unmeasured state for tests', () => {
    const { result } = renderHook(() => useNativeTabContentInsetBottom());
    act(() => publishNativeTabContentInsetBottom(83));
    act(() => resetNativeTabContentInsetForTests());
    expect(result.current).toBeNull();
  });

  it('carries the left and right insets separately', () => {
    // DEVICE_VERIFIED (iPad Pro 13-inch, iPadOS 27.0, landscape): the sidebar is
    // a 280pt left inset inside the tab.
    const { result: left } = renderHook(() => useNativeTabContentInsetLeft());
    const { result: right } = renderHook(() => useNativeTabContentInsetRight());
    expect(left.current).toBeNull();
    expect(right.current).toBeNull();
    act(() => publishNativeTabContentInsetSides(280, 0));
    expect(left.current).toBe(280);
    expect(right.current).toBe(0);
    act(() => publishNativeTabContentInsetSides(0, 84));
    expect(left.current).toBe(0);
    expect(right.current).toBe(84);
  });
});
