// @vitest-environment jsdom
// The screenshot-only board fallback for /climbs/holds, /climbs/zone and
// /climbs/setters. Its whole job is to be inert in a normal build and to hand
// back the active board in a capture — and it fails SILENTLY when it is wrong:
// `getCreateBoardHolds` returns null rather than throwing, so a bad field
// mapping ships three blank screenshots from a run that exits 0.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useScreenshotBoardParams } from '../use-screenshot-board-params';

const getStoredActiveBoard = vi.hoisted(() => vi.fn());

vi.mock('../../lib/active-board-store', () => ({ getStoredActiveBoard }));

// Only the five fields the hook reads; `UserBoard` carries far more, and pinning
// the rest here would make this test fail on unrelated schema growth.
const ACTIVE_BOARD = {
  boardType: 'kilter',
  layoutId: 8,
  sizeId: 25,
  setIds: '26,27,28,29',
  angle: 35,
} as unknown as UserBoard;

const SCREENSHOT_MODE = 'EXPO_PUBLIC_SCREENSHOT_MODE';

beforeEach(() => {
  getStoredActiveBoard.mockReset();
  getStoredActiveBoard.mockResolvedValue(ACTIVE_BOARD);
});

afterEach(() => {
  delete process.env[SCREENSHOT_MODE];
});

describe('useScreenshotBoardParams', () => {
  it('reads nothing at all in a normal build', async () => {
    const { result } = renderHook(() => useScreenshotBoardParams(undefined));

    expect(result.current).toBeNull();
    // The guard is the first statement in the effect, so the store is never
    // touched — this is what lets the whole branch dead-strip from a shipped
    // bundle (see the note at the top of lib/screenshot-mode.ts).
    expect(getStoredActiveBoard).not.toHaveBeenCalled();
  });

  it('falls back to the active board when a screenshot deep link carried none', async () => {
    process.env[SCREENSHOT_MODE] = '1';
    const { result } = renderHook(() => useScreenshotBoardParams(undefined));

    await waitFor(() => expect(result.current).not.toBeNull());
    // Every value is a string: these become route params, and a number here
    // reaches `Number(params.layoutId)` as NaN and draws an empty board.
    expect(result.current).toEqual({
      boardName: 'kilter',
      layoutId: '8',
      sizeId: '25',
      setIds: '26,27,28,29',
      angle: '35',
    });
  });

  it('leaves the real push path from the filter sheet alone', async () => {
    process.env[SCREENSHOT_MODE] = '1';
    const { result } = renderHook(() => useScreenshotBoardParams('kilter'));

    expect(result.current).toBeNull();
    // A route that already carries a board must win outright, or a capture
    // would silently retarget a screen the sheet opened on another wall.
    expect(getStoredActiveBoard).not.toHaveBeenCalled();
  });

  it('stays null when no board has been activated yet', async () => {
    process.env[SCREENSHOT_MODE] = '1';
    getStoredActiveBoard.mockResolvedValue(null);
    const { result } = renderHook(() => useScreenshotBoardParams(undefined));

    await waitFor(() => expect(getStoredActiveBoard).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});
