// @vitest-environment node

// `fetchInitialClimbs` is the SSR seed for "what's lit on the wall right now".
// It is `cache: 'no-store'`, so every kiosk and every board embed render pays
// it for real — which makes it the backend read with the least excuse to be
// unbounded. It already degrades to `[]` (the slot paints the bare board and
// the live subscription fills it in a moment later); these pin that a stalled
// backend reaches that degraded path instead of holding the render open.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/graphql/client', () => ({
  getGraphQLHttpUrl: () => 'http://backend.test/graphql',
}));
vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: () => ({ board_name: 'kilter' }),
}));
vi.mock('../../board-renderer/util', () => ({
  buildBoardRenderUrl: () => 'http://render.test/board.png',
  toFlatFrames: () => '',
}));

import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';
import { buildBoardSlotData, type BoardSlotSource } from '../board-slot-data';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const board: BoardSlotSource = {
  boardId: 42,
  boardUuid: '11111111-1111-4111-8111-111111111111',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
};

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildBoardSlotData — the recent-climbs seed is deadlined', () => {
  it('passes the AbortSignal built from SSR_BACKEND_FETCH_TIMEOUT_MS to fetch', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { boardRecentClimbs: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await buildBoardSlotData(board);

    expect(timeoutSpy).toHaveBeenCalledWith(SSR_BACKEND_FETCH_TIMEOUT_MS);
    const [, requestInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(requestInit.signal).toBe(timeoutSpy.mock.results[0].value);
    expect(requestInit.cache).toBe('no-store');
  });

  it('degrades to an empty seed when the deadline fires', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    const slotData = await buildBoardSlotData(board);

    expect(slotData?.initialClimb).toBeNull();
    expect(slotData?.bareBoardImageUrl).toBe('http://render.test/board.png');
  });
});
