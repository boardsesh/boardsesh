import { afterEach, describe, expect, it } from 'vitest';
import {
  PLAYER_SCROLL_HANDOFF_TTL_MS,
  armPlayerScrollHandoff,
  registerRoutePlayerScroll,
  resetPlayerScrollHandoffForTests,
  takePlayerScrollHandoff,
} from '../player-scroll-handoff';

describe('player-scroll-handoff', () => {
  afterEach(() => {
    resetPlayerScrollHandoffForTests();
  });

  it('hands the route player offset to the pane once, for the same climb', () => {
    registerRoutePlayerScroll(() => ({ climbUuid: 'climb-a', offsetY: 420 }));
    armPlayerScrollHandoff(1_000);
    expect(takePlayerScrollHandoff('climb-b', 1_100)).toBeNull();
    expect(takePlayerScrollHandoff('climb-a', 1_100)).toBe(420);
    expect(takePlayerScrollHandoff('climb-a', 1_200)).toBeNull();
  });

  it('arms nothing when the player is at the top or no route is registered', () => {
    const unregister = registerRoutePlayerScroll(() => ({ climbUuid: 'climb-a', offsetY: 0 }));
    armPlayerScrollHandoff(1_000);
    expect(takePlayerScrollHandoff('climb-a', 1_000)).toBeNull();
    unregister();
    armPlayerScrollHandoff(1_000);
    expect(takePlayerScrollHandoff('climb-a', 1_000)).toBeNull();
  });

  it('drops a handoff nobody took in time', () => {
    registerRoutePlayerScroll(() => ({ climbUuid: 'climb-a', offsetY: 300 }));
    armPlayerScrollHandoff(1_000);
    expect(takePlayerScrollHandoff('climb-a', 1_000 + PLAYER_SCROLL_HANDOFF_TTL_MS + 1)).toBeNull();
  });

  it("keeps a newer route's registration when an older route unregisters late", () => {
    const unregisterOld = registerRoutePlayerScroll(() => ({ climbUuid: 'old', offsetY: 10 }));
    registerRoutePlayerScroll(() => ({ climbUuid: 'new', offsetY: 20 }));
    unregisterOld();
    armPlayerScrollHandoff(1_000);
    expect(takePlayerScrollHandoff('new', 1_000)).toBe(20);
  });
});
