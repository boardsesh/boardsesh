// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { useCallback } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayDrawerSectionId } from '../../../lib/play-drawer-sections-preference';

const authority = vi.hoisted(() => ({ credential: 0 }));
vi.mock('../../../lib/privacy/privacy-cache', () => ({
  getCredentialGeneration: () => authority.credential,
  subscribeToCredentialChanges: () => () => {},
}));
import {
  buildOpeningLayoutKey,
  clearOpeningLayoutCache,
  readOpeningLayout,
  rememberOpeningLayout,
  type OpeningLayoutIdentity,
} from '../opening-layout-cache';
import { usePlayLayoutMeasurements, usePlayOpeningLayout } from '../use-play-opening-layout';

const identity: OpeningLayoutIdentity = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '26,27',
  boardWidth: 1080,
  boardHeight: 1440,
  climbUuid: 'climb-1',
  frames: 'p1r12',
  viewportWidth: 390,
  viewportHeight: 844,
  fontScale: 1,
  pixelRatio: 3,
  locale: 'en-US',
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
  preferencesFingerprint: 'all',
  firstSectionId: 'logbook',
  presentation: 'sheet',
  paneInset: 0,
  headerFingerprint: 'normal',
  controlsFingerprint: 'standard',
  lostBanner: false,
  playbackFingerprint: 'static',
};
const measurements = {
  viewportHeight: 763,
  headerBottomY: 108,
  firstSectionHeaderHeight: 52,
  containerSize: { width: 390, height: 590 },
};
function layout(width: number, height: number, y = 0): LayoutChangeEvent {
  return { nativeEvent: { layout: { x: 0, y, width, height } } } as LayoutChangeEvent;
}
type LayoutInputs = {
  openingLayoutKey: string | undefined;
  windowWidth: number;
  windowHeight: number;
  firstSectionId: PlayDrawerSectionId | undefined;
};
function useMeasuredLayout(props: LayoutInputs) {
  const measured = usePlayLayoutMeasurements();
  const { setSectionHeaderMeasurement } = measured;
  const firstSectionId = props.firstSectionId;
  const firstSectionHeaderHeight =
    measured.sectionHeaderMeasurement.sectionId === firstSectionId ? measured.sectionHeaderMeasurement.height : 0;
  const handleFirstSectionHeaderLayout = useCallback(
    (height: number) => {
      setSectionHeaderMeasurement((previous) =>
        previous.sectionId === firstSectionId && Math.abs(previous.height - height) <= 2
          ? previous
          : { sectionId: firstSectionId, height: Math.round(height) },
      );
    },
    [firstSectionId, setSectionHeaderMeasurement],
  );
  return {
    ...measured,
    firstSectionHeaderHeight,
    ...usePlayOpeningLayout({
      ...props,
      ...measured,
      firstSectionHeaderHeight,
      handleFirstSectionHeaderLayout,
      hasVisibleSections: firstSectionId !== undefined,
    }),
  };
}
function props(key: string | undefined): LayoutInputs {
  return { openingLayoutKey: key, windowWidth: 390, windowHeight: 844, firstSectionId: 'logbook' };
}
function measure(callbacks: ReturnType<typeof useMeasuredLayout>, section = true) {
  callbacks.onViewportMeasured(layout(390, 763));
  callbacks.onHeaderMeasured(layout(390, 100, 8));
  if (section) callbacks.onSectionHeaderMeasured(52);
  callbacks.handleBoardContainerLayout(layout(390, 590));
}

describe('usePlayOpeningLayout', () => {
  beforeEach(() => {
    clearOpeningLayoutCache();
    authority.credential = 0;
  });

  it('provides cached positive board geometry on the initial render without an effect or layout event', () => {
    const key = buildOpeningLayoutKey(identity);
    expect(rememberOpeningLayout(key, measurements)).toBe(true);
    const { result } = renderHook(useMeasuredLayout, { initialProps: props(key) });
    expect(result.current.boardContainerSize).toBe(readOpeningLayout(key)?.containerSize);
    expect(result.current.cachedOpeningLayout).toEqual(measurements);
    expect(result.current.sheetViewportHeight).toBe(0);
  });

  it('waits for every current-key measurement before caching a visible section layout', () => {
    const key = buildOpeningLayoutKey(identity);
    const { result } = renderHook(useMeasuredLayout, { initialProps: props(key) });
    act(() => measure(result.current, false));
    expect(readOpeningLayout(key)).toBeUndefined();
    act(() => result.current.onSectionHeaderMeasured(52));
    expect(readOpeningLayout(key)).toEqual(measurements);
  });

  it('rejects all stale callbacks after switching the complete layout key', () => {
    const oldKey = buildOpeningLayoutKey(identity);
    const newKey = buildOpeningLayoutKey({ ...identity, climbUuid: 'climb-2' });
    const { result, rerender } = renderHook(useMeasuredLayout, { initialProps: props(oldKey) });
    const oldCallbacks = result.current;
    rerender(props(newKey));
    act(() => measure(oldCallbacks));
    expect(result.current.sheetViewportHeight).toBe(0);
    expect(result.current.headerBottomY).toBe(0);
    expect(result.current.boardContainerSize).toBeUndefined();
    expect(readOpeningLayout(oldKey)).toBeUndefined();
    expect(readOpeningLayout(newKey)).toBeUndefined();
    act(() => measure(result.current));
    expect(readOpeningLayout(newKey)).toEqual(measurements);
  });

  it('uses a measured same-viewport fallback without attributing it to the new cache identity', () => {
    const oldKey = buildOpeningLayoutKey(identity);
    const newKey = buildOpeningLayoutKey({ ...identity, controlsFingerprint: 'changed' });
    const { result, rerender } = renderHook(useMeasuredLayout, { initialProps: props(oldKey) });
    act(() => measure(result.current));
    const size = result.current.boardContainerSize;
    rerender(props(newKey));
    expect(result.current.boardContainerSize).toBe(size);
    expect(readOpeningLayout(newKey)).toBeUndefined();
    rerender({ ...props(newKey), windowWidth: 844, windowHeight: 390 });
    expect(result.current.boardContainerSize).toBeUndefined();
  });

  it('keeps the measured board size when a swipe commits to a climb with a stale cached size', () => {
    // Opening climb 1: the board is measured before the first section header
    // is, so its first size is the pre-section one, and that is what the
    // opening key caches.
    const openingKey = buildOpeningLayoutKey(identity);
    const liveStatsKey = buildOpeningLayoutKey({ ...identity, headerFingerprint: 'live stats' });
    const nextClimbKey = buildOpeningLayoutKey({ ...identity, climbUuid: 'climb-2' });
    const { result, rerender } = renderHook(useMeasuredLayout, { initialProps: props(openingKey) });
    act(() => {
      result.current.onViewportMeasured(layout(390, 763));
      result.current.onHeaderMeasured(layout(390, 100, 8));
      result.current.handleBoardContainerLayout(layout(390, 572));
      result.current.onSectionHeaderMeasured(52);
    });
    expect(readOpeningLayout(openingKey)?.containerSize).toEqual({ width: 390, height: 572 });
    // The header's live stats land before the settled layout does.
    rerender(props(liveStatsKey));
    act(() => result.current.handleBoardContainerLayout(layout(390, 590)));
    expect(readOpeningLayout(openingKey)?.containerSize).toEqual({ width: 390, height: 572 });
    // Swipe to climb 2 and back: the commit render carries climb 1's opening key.
    rerender(props(nextClimbKey));
    expect(result.current.boardContainerSize).toMatchObject({ width: 390, height: 590 });
    rerender(props(openingKey));
    expect(result.current.boardContainerSize).toMatchObject({ width: 390, height: 590 });
  });

  it('uses the cached size for a new window size until the board is measured in it', () => {
    const key = buildOpeningLayoutKey(identity);
    const rotatedKey = buildOpeningLayoutKey({ ...identity, viewportWidth: 844, viewportHeight: 390 });
    rememberOpeningLayout(rotatedKey, { ...measurements, containerSize: { width: 600, height: 300 } });
    const { result, rerender } = renderHook(useMeasuredLayout, { initialProps: props(key) });
    act(() => measure(result.current));
    rerender({ ...props(rotatedKey), windowWidth: 844, windowHeight: 390 });
    expect(result.current.boardContainerSize).toEqual({ width: 600, height: 300 });
    act(() => result.current.handleBoardContainerLayout(layout(610, 290)));
    expect(result.current.boardContainerSize).toMatchObject({ width: 610, height: 290 });
  });

  it('rejects zero board bounds and coalesces two-pixel measurement jitter', () => {
    const key = buildOpeningLayoutKey(identity);
    const { result } = renderHook(useMeasuredLayout, { initialProps: props(key) });
    act(() => result.current.handleBoardContainerLayout(layout(0, 590)));
    expect(result.current.boardContainerSize).toBeUndefined();
    act(() => measure(result.current));
    const size = result.current.boardContainerSize;
    act(() => {
      result.current.onViewportMeasured(layout(390, 764.5));
      result.current.onHeaderMeasured(layout(390, 101, 8));
      result.current.onSectionHeaderMeasured(53.5);
      result.current.handleBoardContainerLayout(layout(390, 590));
    });
    expect(result.current.sheetViewportHeight).toBe(763);
    expect(result.current.headerBottomY).toBe(108);
    expect(result.current.firstSectionHeaderHeight).toBe(52);
    expect(result.current.boardContainerSize).toBe(size);
  });

  it('caches a layout with no visible section without waiting for a section callback', () => {
    const key = buildOpeningLayoutKey({ ...identity, firstSectionId: null });
    const { result } = renderHook(useMeasuredLayout, { initialProps: { ...props(key), firstSectionId: undefined } });
    act(() => measure(result.current, false));
    expect(readOpeningLayout(key)).toEqual({ ...measurements, firstSectionHeaderHeight: 0 });
  });

  it('cannot repopulate a revoked cache using a previously captured key', () => {
    const key = buildOpeningLayoutKey(identity);
    const { result } = renderHook(useMeasuredLayout, { initialProps: props(key) });
    authority.credential++;
    act(() => measure(result.current));
    expect(readOpeningLayout(key)).toBeUndefined();
  });
});
