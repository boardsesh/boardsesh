// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FlashListRef } from '@shopify/flash-list';
import { readFlashListViewport, useVisibleArtReadiness } from '../use-visible-art-readiness';
const assetId = (item: { id: string | null }) => item.id;
const visible = (...ids: Array<string | null>) => ({ viewableItems: ids.map((id) => ({ item: { id } })) });
describe('visible story artwork readiness', () => {
  it('waits for both the viewport and every visible board to display', () => {
    const onReady = vi.fn();
    const { result } = renderHook(() => useVisibleArtReadiness(assetId, onReady));
    act(() => result.current.onDisplayed('first'));
    expect(onReady).not.toHaveBeenCalled();
    act(() => result.current.onViewableItemsChanged(visible('first', 'second')));
    expect(onReady).not.toHaveBeenCalled();
    act(() => result.current.onDisplayed('second'));
    expect(onReady).toHaveBeenCalledOnce();
  });
  it('does not wait for virtual rows outside the viewport', () => {
    const onReady = vi.fn();
    const { result } = renderHook(() => useVisibleArtReadiness(assetId, onReady));
    act(() => result.current.onViewableItemsChanged(visible('visible')));
    act(() => result.current.onDisplayed('offscreen'));
    expect(onReady).not.toHaveBeenCalled();
    act(() => result.current.onDisplayed('visible'));
    expect(onReady).toHaveBeenCalledOnce();
  });
  it('accepts an authoritative empty viewport after list paint', () => {
    const onReady = vi.fn();
    const { result } = renderHook(() => useVisibleArtReadiness(assetId, onReady));
    act(() => result.current.onInitialViewport([]));
    expect(onReady).toHaveBeenCalledOnce();
  });
  it('ignores an empty measurement and accepts visible text-only rows', () => {
    const onReady = vi.fn();
    const { result } = renderHook(() => useVisibleArtReadiness(assetId, onReady));
    act(() => result.current.onViewableItemsChanged(visible()));
    expect(onReady).not.toHaveBeenCalled();
    act(() => result.current.onViewableItemsChanged(visible(null)));
    expect(onReady).toHaveBeenCalledOnce();
  });
});

describe('FlashList painted viewport', () => {
  function list(headerHeight: number): FlashListRef<string> {
    return {
      computeVisibleIndices: () => ({ startIndex: 0, endIndex: 1 }),
      getFirstItemOffset: () => headerHeight,
      getAbsoluteLastScrollOffset: () => 0,
      getWindowSize: () => ({ width: 400, height: 600 }),
      getLayout: (index: number) => ({ y: index * 100, height: 100 }),
    } as unknown as FlashListRef<string>;
  }
  it('does not wait for rows below a full-height header', () => {
    expect(readFlashListViewport(list(650), ['first', 'second'])).toEqual([]);
  });
  it('includes a partially visible row but excludes a row below the viewport', () => {
    expect(readFlashListViewport(list(550), ['first', 'second'])).toEqual(['first']);
  });
});
