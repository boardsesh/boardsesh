// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Climb } from '@boardsesh/shared-schema';

/**
 * The gate on the lost-holds banner's Edit button (#6024). It must agree with
 * the climb-actions menu: the setter always on a spray wall, a wall editor on a
 * published spray climb, nobody else.
 */

const state = { profileId: null as string | null, viewerCanEditClimbs: false };

vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: state.profileId ? { id: state.profileId } : undefined }),
}));

vi.mock('../../../lib/spray/use-spray-wall', () => ({
  useSprayWallViewerCanEditClimbs: () => state.viewerCanEditClimbs,
}));

const { useCanEditDisplayedClimb } = await import('../use-can-edit-displayed-climb');

const LONG_AGO = '2026-01-01T00:00:00.000Z';

function sprayClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-1',
    userId: 'setter',
    is_draft: false,
    created_at: LONG_AGO,
    published_at: LONG_AGO,
    boardType: 'spray',
    layoutId: 7,
    ...overrides,
  } as unknown as Climb;
}

describe('useCanEditDisplayedClimb', () => {
  beforeEach(() => {
    state.profileId = null;
    state.viewerCanEditClimbs = false;
  });

  it('lets the setter edit a spray climb published long ago', () => {
    state.profileId = 'setter';
    const { result } = renderHook(() => useCanEditDisplayedClimb(sprayClimb(), 'spray', 7));
    expect(result.current).toBe(true);
  });

  it('lets a wall editor edit somebody else’s published spray climb', () => {
    state.profileId = 'gym-admin';
    state.viewerCanEditClimbs = true;
    const { result } = renderHook(() => useCanEditDisplayedClimb(sprayClimb(), 'spray', 7));
    expect(result.current).toBe(true);
  });

  it('refuses a climber who neither set the climb nor can edit the wall', () => {
    state.profileId = 'stranger';
    const { result } = renderHook(() => useCanEditDisplayedClimb(sprayClimb(), 'spray', 7));
    expect(result.current).toBe(false);
  });

  it('refuses a signed-out viewer and an absent climb', () => {
    const signedOut = renderHook(() => useCanEditDisplayedClimb(sprayClimb(), 'spray', 7));
    expect(signedOut.result.current).toBe(false);
    state.profileId = 'setter';
    const noClimb = renderHook(() => useCanEditDisplayedClimb(null, 'spray', 7));
    expect(noClimb.result.current).toBe(false);
  });
});
