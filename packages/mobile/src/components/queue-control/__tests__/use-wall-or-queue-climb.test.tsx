// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  enabled: true,
  boardId: 1 as number | null,
  hasWallClimb: true,
}));

vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({ enabled: cfg.enabled, boardId: cfg.boardId }),
}));
vi.mock('@boardsesh/board-presence-react', () => ({
  useBoardPresenceHasClimb: () => cfg.hasWallClimb,
  // Imported at module top for the sibling hooks; unused by useHasWallClimb.
  useBoardPresenceCurrent: () => ({ currentClimb: null, isLive: false }),
}));
vi.mock('../../../lib/board-presence/presence-climb', () => ({
  boardPresenceClimbToClimb: (climb: unknown) => climb,
}));

import { useHasWallClimb } from '../use-wall-or-queue-climb';

describe('useHasWallClimb', () => {
  beforeEach(() => {
    cfg.enabled = true;
    cfg.boardId = 1;
    cfg.hasWallClimb = true;
  });

  it('is true when the feature is enabled, a board is bound, and a wall climb is live', () => {
    const { result } = renderHook(() => useHasWallClimb());
    expect(result.current).toBe(true);
  });

  it('is false when the feature is disabled', () => {
    cfg.enabled = false;
    const { result } = renderHook(() => useHasWallClimb());
    expect(result.current).toBe(false);
  });

  it('is false when no board is bound', () => {
    cfg.boardId = null;
    const { result } = renderHook(() => useHasWallClimb());
    expect(result.current).toBe(false);
  });

  it('is false when the live feed has no current climb', () => {
    cfg.hasWallClimb = false;
    const { result } = renderHook(() => useHasWallClimb());
    expect(result.current).toBe(false);
  });
});
