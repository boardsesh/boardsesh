// @vitest-environment jsdom
import { beforeEach, describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  publishNativeTabContentInsetBottom,
  resetNativeTabContentInsetForTests,
  useNativeTabContentInsetBottom,
  useNativeTabContentInsetPublishCount,
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

  it('resets to the unmeasured state for tests', () => {
    const { result } = renderHook(() => useNativeTabContentInsetBottom());
    act(() => publishNativeTabContentInsetBottom(83));
    act(() => resetNativeTabContentInsetForTests());
    expect(result.current).toBeNull();
  });
});
