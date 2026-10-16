// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  __resetConnectivityBannerHeightForTests,
  publishBottomOverlayHeight,
  publishConnectivityBannerHeight,
  useConnectivityBannerHeight,
  useConnectivityCardHeight,
} from '../connectivity-banner-inset-store';

describe('bottom overlay insets', () => {
  beforeEach(__resetConnectivityBannerHeightForTests);
  it('adds download and connectivity heights independently', () => {
    const { result } = renderHook(() => ({ total: useConnectivityBannerHeight(), card: useConnectivityCardHeight() }));
    act(() => {
      publishConnectivityBannerHeight(50);
      publishBottomOverlayHeight('download', 70);
    });
    expect(result.current).toEqual({ total: 120, card: 50 });
    act(() => publishBottomOverlayHeight('download', 0));
    expect(result.current).toEqual({ total: 50, card: 50 });
    act(() => {
      publishBottomOverlayHeight('download', 70);
      publishConnectivityBannerHeight(0);
    });
    expect(result.current).toEqual({ total: 70, card: 0 });
  });
  it('ignores layout jitter in either overlay', () => {
    const { result } = renderHook(useConnectivityBannerHeight);
    act(() => {
      publishConnectivityBannerHeight(50);
      publishBottomOverlayHeight('download', 70);
    });
    act(() => {
      publishConnectivityBannerHeight(50.4);
      publishBottomOverlayHeight('download', 70.4);
    });
    expect(result.current).toBe(120);
  });
});
