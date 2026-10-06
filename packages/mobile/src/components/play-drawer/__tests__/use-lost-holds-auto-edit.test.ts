// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Climb } from '@boardsesh/shared-schema';

/**
 * Set-active routing for a climb that lost holds (#5493): who gets the editor
 * instead of the player, and the gates that keep it from being a surprise.
 */

const navigation = vi.hoisted(() => ({ openEdit: vi.fn(), resetActionGuard: vi.fn() }));
const registry = vi.hoisted(() => ({
  wall: null as { holds: { id: number }[] } | null,
  canEditClimbs: false,
}));
const tracked = vi.hoisted(() => [] as unknown[]);

vi.mock('../../create-climb/use-create-climb-navigation', () => ({
  useCreateClimbNavigation: () => navigation,
}));
vi.mock('../../../lib/spray/spray-wall-registry', () => ({
  SPRAY_BOARD_NAME: 'spray',
  getSprayWall: () => registry.wall,
  sprayWallViewerCanEditClimbs: () => registry.canEditClimbs,
  ensureSprayWallLoaded: () => {},
}));
// The real resolver reaches the playlist render cache; the climb is on the
// stored wall in every case here, so draw it there.
vi.mock('../../../lib/boards/climb-render-board', () => ({
  resolveClimbRenderBoard: (_climb: unknown, board: unknown) => ({
    boardConfig: board,
    fit: 'exact',
    incompatible: false,
  }),
}));
vi.mock('../../../lib/spray/spray-telemetry', () => ({
  trackSprayEvent: (event: unknown) => tracked.push(event),
}));

const { shouldAutoEditBrokenClimb, useLostHoldsAutoEdit } = await import('../use-lost-holds-auto-edit');

const ROUTABLE = {
  missingHoldCount: 1,
  isSprayClimb: true,
  isPreview: false,
  isAlreadyCurrent: false,
  isSharedSession: false,
  isOtherBoard: false,
  playerOpen: false,
  viewerCanEdit: true,
  readiness: 'ready' as const,
};

describe('shouldAutoEditBrokenClimb', () => {
  it('routes a broken spray climb the viewer can fix', () => {
    expect(shouldAutoEditBrokenClimb(ROUTABLE)).toBe(true);
  });

  it.each([
    ['an intact climb', { missingHoldCount: 0 }],
    ['an unknown count', { missingHoldCount: null }],
    ['a catalogue climb', { isSprayClimb: false }],
    ['a preview', { isPreview: true }],
    ['a reopen of the current climb', { isAlreadyCurrent: true }],
    ['a crew session', { isSharedSession: true }],
    ['another board', { isOtherBoard: true }],
    ['an open player', { playerOpen: true }],
    ['a viewer who cannot edit', { viewerCanEdit: false }],
    ['a stale wall', { readiness: 'wall-stale' as const }],
    ['a climb with nothing left', { readiness: 'nothing-left' as const }],
  ])('keeps the player for %s', (_label, override) => {
    expect(shouldAutoEditBrokenClimb({ ...ROUTABLE, ...override })).toBe(false);
  });
});

const SPRAY_BOARD = { boardName: 'spray' as const, layoutId: 7, sizeId: 1, setIds: '1', angle: 40 };
// Holds 1 and 2; hold 2 came off the wall.
const brokenClimb = {
  uuid: 'climb-1',
  frames: 'p1r1p2r2',
  missingHoldCount: 1,
  boardType: 'spray',
  layoutId: 7,
  userId: 'setter',
  is_draft: false,
} as unknown as Climb;

const CONTEXT = {
  storedBoard: SPRAY_BOARD,
  boardOverride: undefined,
  isPreview: false,
  isAlreadyCurrent: false,
  isSharedSession: false,
  playerOpen: false,
};

describe('useLostHoldsAutoEdit', () => {
  beforeEach(() => {
    navigation.openEdit.mockClear();
    navigation.resetActionGuard.mockClear();
    tracked.length = 0;
    registry.wall = { holds: [{ id: 1 }] };
    registry.canEditClimbs = false;
  });

  it('opens the setter straight into the editor and says where it came from', () => {
    const { result } = renderHook(() =>
      useLostHoldsAutoEdit({ currentUserId: 'setter', dismissSourceSheets: vi.fn() }),
    );
    expect(result.current.tryAutoEdit(brokenClimb, CONTEXT)).toBe('routed');
    expect(navigation.openEdit).toHaveBeenCalledWith(brokenClimb, SPRAY_BOARD);
    expect(tracked).toEqual([expect.objectContaining({ properties: { lostHoldCount: 1, source: 'set_active' } })]);
  });

  it('routes a wall editor who did not set the climb', () => {
    registry.canEditClimbs = true;
    const { result } = renderHook(() => useLostHoldsAutoEdit({ currentUserId: 'owner', dismissSourceSheets: vi.fn() }));
    expect(result.current.tryAutoEdit(brokenClimb, CONTEXT)).toBe('routed');
  });

  it('leaves a stranger on the player', () => {
    const { result } = renderHook(() =>
      useLostHoldsAutoEdit({ currentUserId: 'stranger', dismissSourceSheets: vi.fn() }),
    );
    expect(result.current.tryAutoEdit(brokenClimb, CONTEXT)).toBe('declined');
    expect(navigation.openEdit).not.toHaveBeenCalled();
  });

  it('declines while the device wall still has the lost hold', () => {
    registry.wall = { holds: [{ id: 1 }, { id: 2 }] };
    const { result } = renderHook(() =>
      useLostHoldsAutoEdit({ currentUserId: 'setter', dismissSourceSheets: vi.fn() }),
    );
    expect(result.current.tryAutoEdit(brokenClimb, CONTEXT)).toBe('declined');
  });

  it('swallows a double tap instead of opening the player over the editor', () => {
    const { result } = renderHook(() =>
      useLostHoldsAutoEdit({ currentUserId: 'setter', dismissSourceSheets: vi.fn() }),
    );
    expect(result.current.tryAutoEdit(brokenClimb, CONTEXT)).toBe('routed');
    expect(result.current.tryAutoEdit(brokenClimb, CONTEXT)).toBe('swallowed');
    expect(navigation.openEdit).toHaveBeenCalledTimes(1);
  });

  it('declines a climb opened onto another board', () => {
    const { result } = renderHook(() =>
      useLostHoldsAutoEdit({ currentUserId: 'setter', dismissSourceSheets: vi.fn() }),
    );
    expect(
      result.current.tryAutoEdit(brokenClimb, { ...CONTEXT, boardOverride: { ...SPRAY_BOARD, layoutId: 99 } }),
    ).toBe('declined');
  });
});
