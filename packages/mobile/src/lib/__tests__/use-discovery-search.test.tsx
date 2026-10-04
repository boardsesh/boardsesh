// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDiscoverySearch } from '../use-discovery-search';
import type { Coords } from '../use-device-location';
import type { WallFinderFilter } from '../wall-finder-filter';

const madrid: Coords = { latitude: 40.47, longitude: -3.86 };
const moved: Coords = { latitude: 40.5, longitude: -3.9 };
const place: Coords = { latitude: 48.86, longitude: 2.35 };
const acceptCamera = (next: Coords) => next;

function advance(milliseconds: number) {
  act(() => {
    vi.advanceTimersByTime(milliseconds);
  });
}

function mountSearch(center: Coords | null = madrid, filter: WallFinderFilter = {}) {
  return renderHook(
    (input: { center: Coords | null; filter: WallFinderFilter }) =>
      useDiscoverySearch(input.center, input.filter, { resolveCameraCenter: acceptCamera }),
    { initialProps: { center, filter } },
  );
}

describe('useDiscoverySearch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it.each(['location', 'name'])('commits the first usable %s search immediately', (source) => {
    const { result, rerender } = mountSearch(null);
    const input = source === 'location' ? { center: madrid, filter: {} } : { center: null, filter: { name: 'Climb' } };
    rerender(input);
    expect(result.current.search).toEqual(input);
    expect(result.current.isDebouncing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces chip changes to the final filters after 500 ms', () => {
    const { result, rerender } = mountSearch();
    rerender({ center: madrid, filter: { boardTypes: ['kilter'] } });
    advance(300);
    const finalFilter: WallFinderFilter = { boardTypes: ['tension'] };
    rerender({ center: madrid, filter: finalFilter });
    advance(499);
    expect(result.current.search.filter).toEqual({});
    expect(result.current.isDebouncing).toBe(true);
    advance(1);
    expect(result.current.search).toEqual({ center: madrid, filter: finalFilter });
    expect(result.current.isDebouncing).toBe(false);
  });

  it('uses one trailing timer for camera movement and chip changes', () => {
    const { result, rerender } = mountSearch();
    act(() => result.current.cameraMoved(moved));
    advance(200);
    rerender({ center: madrid, filter: { boardTypes: ['kilter'] } });
    advance(200);
    act(() => result.current.cameraMoved(place));
    expect(vi.getTimerCount()).toBe(1);
    advance(499);
    expect(result.current.search).toEqual({ center: madrid, filter: {} });
    advance(1);
    expect(result.current.search).toEqual({ center: place, filter: { boardTypes: ['kilter'] } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([madrid, { latitude: 40.47001, longitude: -3.86 }])(
    'preserves chip changes when camera resolution ignores an echo or tiny nudge: %j',
    (cameraCenter) => {
      const resolveCameraCenter = vi.fn((_next: Coords, current: Coords | null) => current);
      const { result, rerender } = renderHook(
        ({ filter }: { filter: WallFinderFilter }) => useDiscoverySearch(madrid, filter, { resolveCameraCenter }),
        { initialProps: { filter: {} } },
      );
      act(() => result.current.cameraMoved(cameraCenter));
      rerender({ filter: { boardTypes: ['kilter'] } });
      advance(500);
      expect(resolveCameraCenter).toHaveBeenCalledWith(cameraCenter, madrid);
      expect(result.current.search).toEqual({ center: madrid, filter: { boardTypes: ['kilter'] } });
    },
  );

  it('does not render for every camera frame', () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useDiscoverySearch(madrid, {}, { resolveCameraCenter: acceptCamera });
    });
    act(() => result.current.cameraMoved(moved));
    const countAfterFirstFrame = renderCount;
    for (let frame = 0; frame < 30; frame += 1) {
      act(() => result.current.cameraMoved({ latitude: 40.5 + frame / 1000, longitude: -3.9 }));
    }
    expect(renderCount).toBe(countAfterFirstFrame);
    advance(500);
    expect(result.current.search.center?.latitude).toBe(40.529);
  });

  it('replaces a pending pan with a programmatic center', () => {
    const { result, rerender } = mountSearch();
    act(() => result.current.cameraMoved(moved));
    advance(250);
    rerender({ center: place, filter: { place: 'Paris' } });
    advance(500);
    expect(result.current.search).toEqual({ center: place, filter: { place: 'Paris' } });
  });

  it('reset at the unchanged external center cancels a pending pan', () => {
    const { result } = mountSearch();
    act(() => result.current.cameraMoved(moved));
    act(() => result.current.resetSearch({ center: madrid, filter: {} }));
    expect(result.current.isDebouncing).toBe(false);
    advance(1000);
    expect(result.current.search).toEqual({ center: madrid, filter: {} });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the pending timer on unmount', () => {
    const { result, unmount } = mountSearch();
    act(() => result.current.cameraMoved(moved));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('equal-content objects neither replace committed search nor restart a pending timer', () => {
    const { result, rerender } = mountSearch();
    const originalSearch = result.current.search;
    rerender({ center: { ...madrid }, filter: {} });
    expect(result.current.search).toBe(originalSearch);
    expect(result.current.isDebouncing).toBe(false);
    rerender({ center: madrid, filter: { boardTypes: ['kilter'] } });
    advance(300);
    rerender({ center: { ...madrid }, filter: { boardTypes: ['kilter'] } });
    advance(200);
    expect(result.current.search.filter).toEqual({ boardTypes: ['kilter'] });
    expect(result.current.isDebouncing).toBe(false);
  });
});
