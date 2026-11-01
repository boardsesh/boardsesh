// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  PLAYER_SCROLL_HANDOFF_TTL_MS,
  armPlayerScrollHandoff,
  publishRoutePlayerBusy,
  readRoutePlayerSnapshot,
  registerRoutePlayer,
  resetRoutePlayerHandoffForTests,
  takePlayerScrollHandoff,
  useReportRoutePlayerBusy,
  useRoutePlayerBusy,
} from '../route-player-handoff';

describe('route-player-handoff', () => {
  afterEach(() => {
    resetRoutePlayerHandoffForTests();
  });

  it('hands the route offset to the pane once, for the same climb', () => {
    armPlayerScrollHandoff({ climbUuid: 'climb-a', offsetY: 420 }, 1_000);
    expect(takePlayerScrollHandoff('climb-b', 1_100)).toBeNull();
    expect(takePlayerScrollHandoff('climb-a', 1_100)).toBe(420);
    expect(takePlayerScrollHandoff('climb-a', 1_200)).toBeNull();
  });

  it('arms nothing for a player at the top or with no climb', () => {
    armPlayerScrollHandoff({ climbUuid: 'climb-a', offsetY: 0 }, 1_000);
    expect(takePlayerScrollHandoff('climb-a', 1_000)).toBeNull();
    armPlayerScrollHandoff(null, 1_000);
    expect(takePlayerScrollHandoff('climb-a', 1_000)).toBeNull();
  });

  it('drops a handoff nobody took in time', () => {
    armPlayerScrollHandoff({ climbUuid: 'climb-a', offsetY: 300 }, 1_000);
    expect(takePlayerScrollHandoff('climb-a', 1_000 + PLAYER_SCROLL_HANDOFF_TTL_MS + 1)).toBeNull();
  });

  it("reads the registered route's live state, and keeps a newer route when an older one unregisters late", () => {
    const unregisterOld = registerRoutePlayer(() => ({ climbUuid: 'old', offsetY: 10, preview: null }));
    registerRoutePlayer(() => ({ climbUuid: 'new', offsetY: 20, preview: null }));
    unregisterOld();
    expect(readRoutePlayerSnapshot()).toEqual({ climbUuid: 'new', offsetY: 20, preview: null });
  });

  it('is busy while either the player or the route around it has something open', () => {
    const { result } = renderHook(() => useRoutePlayerBusy(true));
    expect(result.current).toBe(false);
    act(() => publishRoutePlayerBusy('player', true));
    act(() => publishRoutePlayerBusy('route', true));
    act(() => publishRoutePlayerBusy('player', false));
    // The route's queue sheet is still up.
    expect(result.current).toBe(true);
    act(() => publishRoutePlayerBusy('route', false));
    expect(result.current).toBe(false);
  });

  it('goes idle when a reporting source unmounts', () => {
    const busy = renderHook(() => useRoutePlayerBusy(true));
    const reporter = renderHook(() => useReportRoutePlayerBusy('route', true));
    expect(busy.result.current).toBe(true);
    act(() => reporter.unmount());
    expect(busy.result.current).toBe(false);
  });

  it('reads as idle and stays unsubscribed while not enabled', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useRoutePlayerBusy(false);
    });
    const rendersBefore = renders;
    act(() => publishRoutePlayerBusy('player', true));
    expect(result.current).toBe(false);
    expect(renders).toBe(rendersBefore);
  });
});
