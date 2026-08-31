// @vitest-environment jsdom
//
// The distinction this file exists for: `loading` means "ask me again" and
// `unavailable` means "there is nothing to show this launch". The board-look
// gate turns the first into `wait` and the second into `none`, so collapsing
// them would either strand a fresh install that has not picked a board yet, or
// burn its one-time step on an empty wall.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';

const activeBoardCtrl = vi.hoisted(() => ({
  data: undefined as undefined | null | Record<string, unknown>,
}));
const searchCtrl = vi.hoisted(() => ({
  enabledCalls: [] as boolean[],
  frames: 'p1r12' as string | null,
  isPending: false,
}));
const renderDataCtrl = vi.hoisted(() => ({ value: { boardWidth: 1080, boardHeight: 1350 } as unknown }));

vi.mock('../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: activeBoardCtrl.data }) }));
vi.mock('../../lib/graphql/hooks/use-infinite-search-climbs', () => ({
  useInfiniteSearchClimbs: (_input: unknown, enabled: boolean) => {
    searchCtrl.enabledCalls.push(enabled);
    return {
      data: searchCtrl.frames ? { pages: [{ climbs: [{ frames: searchCtrl.frames }] }] } : undefined,
      isPending: searchCtrl.isPending,
    };
  },
}));
vi.mock('../../lib/board-details', () => ({ getBoardRenderData: () => renderDataCtrl.value }));

const { useBoardPreviewClimb } = await import('../use-board-preview-climb');

const BOARD = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };

beforeEach(() => {
  activeBoardCtrl.data = BOARD;
  searchCtrl.enabledCalls = [];
  searchCtrl.frames = 'p1r12';
  searchCtrl.isPending = false;
  renderDataCtrl.value = { boardWidth: 1080, boardHeight: 1350 };
});

afterEach(() => {
  cleanup();
});

describe('useBoardPreviewClimb', () => {
  it('resolves the active board and a real climb on it', () => {
    const { result } = renderHook(() => useBoardPreviewClimb());

    expect(result.current.status).toBe('ready');
    expect(result.current.preview).toMatchObject({
      frames: 'p1r12',
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
      boardWidth: 1080,
      boardHeight: 1350,
    });
  });

  describe('waits — the caller should ask again', () => {
    it('while the stored active board is still being read', () => {
      // `undefined` is the AsyncStorage read in flight, not "no board".
      activeBoardCtrl.data = undefined;
      const { result } = renderHook(() => useBoardPreviewClimb());
      expect(result.current.status).toBe('loading');
    });

    it('while the example-climb query is still pending', () => {
      searchCtrl.frames = null;
      searchCtrl.isPending = true;
      const { result } = renderHook(() => useBoardPreviewClimb());
      expect(result.current.status).toBe('loading');
    });

    it('while disabled, so a disarmed caller never reads as "nothing to show"', () => {
      // The gate passes `false` until its cheap checks pass. Reporting
      // `unavailable` there would rule the step out before it was ever weighed.
      const { result } = renderHook(() => useBoardPreviewClimb(false));
      expect(result.current.status).toBe('loading');
    });
  });

  describe('is unavailable — nothing to show this launch', () => {
    it('when the climber has bound no board at all', () => {
      activeBoardCtrl.data = null;
      const { result } = renderHook(() => useBoardPreviewClimb());
      expect(result.current.status).toBe('unavailable');
      expect(result.current.preview).toBeNull();
    });

    it('when the board config has no render geometry', () => {
      renderDataCtrl.value = null;
      const { result } = renderHook(() => useBoardPreviewClimb());
      expect(result.current.status).toBe('unavailable');
    });

    it('when the query settled with no climb — a board this device never synced', () => {
      searchCtrl.frames = null;
      searchCtrl.isPending = false;
      const { result } = renderHook(() => useBoardPreviewClimb());
      expect(result.current.status).toBe('unavailable');
    });
  });

  it('does not run the climb query until it is enabled', () => {
    renderHook(() => useBoardPreviewClimb(false));
    // The cost gate: two native renders and a query are not paid for by a
    // climber the gate has already ruled out.
    expect(searchCtrl.enabledCalls.every((enabled) => !enabled)).toBe(true);
  });

  it('runs the query once enabled and a board exists', () => {
    renderHook(() => useBoardPreviewClimb(true));
    expect(searchCtrl.enabledCalls.some((enabled) => enabled)).toBe(true);
  });
});
