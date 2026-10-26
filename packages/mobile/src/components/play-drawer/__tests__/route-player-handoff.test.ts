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

  it('reports the route busy while work is open, and idle once the route goes', () => {
    const unregister = registerRoutePlayer(() => ({ climbUuid: 'a', offsetY: 0, preview: null }));
    const { result } = renderHook(() => useRoutePlayerBusy());
    expect(result.current).toBe(false);
    act(() => publishRoutePlayerBusy(true));
    expect(result.current).toBe(true);
    act(() => unregister());
    expect(result.current).toBe(false);
    expect(readRoutePlayerSnapshot()).toBeNull();
  });
});
