// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  enabled: true,
  boardId: 1 as number | null,
  // Mirrors `BoardPresenceWallClimbContext`'s own value: `isLive ? currentClimb
  // : null` is computed by the provider, so the hook under test only ever sees
  // the already-collapsed wall climb (or null).
  wallClimb: { climbUuid: 'wall-1', name: 'Wax On', difficulty: 15 } as {
    climbUuid: string;
    name: string;
    difficulty: number;
  } | null,
}));

vi.mock('../../../providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({ enabled: cfg.enabled, boardId: cfg.boardId }),
}));
vi.mock('@boardsesh/board-presence-react', () => ({
  useBoardPresenceWallClimb: () => cfg.wallClimb,
}));

import { useLiveWallClimb } from '../use-wall-or-queue-climb';

describe('useLiveWallClimb', () => {
  beforeEach(() => {
    cfg.enabled = true;
    cfg.boardId = 1;
    cfg.wallClimb = { climbUuid: 'wall-1', name: 'Wax On', difficulty: 15 };
  });

  it('returns the wall climb while the feed is live, whatever the queue holds', () => {
    const { result } = renderHook(() => useLiveWallClimb());
    expect(result.current).toEqual(cfg.wallClimb);
  });

  it('returns null when the feature is disabled', () => {
    cfg.enabled = false;
    const { result } = renderHook(() => useLiveWallClimb());
    expect(result.current).toBeNull();
  });

  it('returns null when no board is bound', () => {
    cfg.boardId = null;
    const { result } = renderHook(() => useLiveWallClimb());
    expect(result.current).toBeNull();
  });

  it('returns null when the feed is not live or has no current climb (context already collapses to null)', () => {
    cfg.wallClimb = null;
    const { result } = renderHook(() => useLiveWallClimb());
    expect(result.current).toBeNull();
  });

  it('keeps the same climb reference across re-renders with no wall event', () => {
    const { result, rerender } = renderHook(() => useLiveWallClimb());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
