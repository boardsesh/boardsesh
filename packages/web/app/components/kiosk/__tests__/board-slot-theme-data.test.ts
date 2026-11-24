// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/graphql/client', () => ({ getGraphQLHttpUrl: () => 'http://backend.test/graphql' }));
vi.mock('@/app/lib/board-image-details', () => ({
  getBoardImageDetailsForBoard: () => ({ board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] }),
}));

import { buildBoardSlotData, type BoardSlotSource } from '../board-slot-data';

const mockFetch = vi.fn();
const board: BoardSlotSource = {
  boardId: 42,
  boardUuid: '11111111-1111-4111-8111-111111111111',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
};

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ data: { boardRecentClimbs: [{ frames: 'p1r12,p2r13' }] } })),
  );
});

afterEach(() => {
  mockFetch.mockReset();
  vi.unstubAllGlobals();
});

describe('server-seeded kiosk board appearance', () => {
  it.each([
    { theme: 'light' as const, fieldColor: '#FFFFFF' },
    { theme: 'dark' as const, fieldColor: '#181225' },
  ])('uses the $theme field for both the lit climb and empty-board seed', async ({ theme, fieldColor }) => {
    const slot = await buildBoardSlotData(board, theme);
    expect(slot).not.toBeNull();
    const current = new URL(slot!.initialClimbImageUrl!, 'https://www.boardsesh.com');
    const bare = new URL(slot!.bareBoardImageUrl, 'https://www.boardsesh.com');
    expect(current.searchParams.get('field_color')).toBe(fieldColor);
    expect(bare.searchParams.get('field_color')).toBe(fieldColor);
    expect(current.searchParams.get('frames')).toBe('p1r42p2r43');
    expect(bare.searchParams.get('frames')).toBe('');
  });

  it('preserves the dark field for embed callers without a kiosk theme', async () => {
    const slot = await buildBoardSlotData(board);
    const current = new URL(slot!.initialClimbImageUrl!, 'https://www.boardsesh.com');
    expect(current.searchParams.get('field_color')).toBe('#181225');
  });
});
