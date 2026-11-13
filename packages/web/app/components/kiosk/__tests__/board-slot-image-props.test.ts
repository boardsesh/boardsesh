// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { getBoardImageDetailsForBoard } from '@/app/lib/board-image-details';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/graphql/client', () => ({ getGraphQLHttpUrl: () => 'http://backend.test/graphql' }));
import { buildBoardSlotData } from '../board-slot-data';

afterEach(() => vi.unstubAllGlobals());

describe('real kiosk image metadata transport', () => {
  it.each([
    { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' },
    { boardType: 'tension', layoutId: 9, sizeId: 1, setIds: '8,9,10,11' },
    { boardType: 'moonboard', layoutId: 6, sizeId: 1, setIds: '24,25,26,27' },
    { boardType: 'woods', layoutId: 1, sizeId: 2, setIds: '1' },
  ])('passes no per-hold geometry to the kiosk client: $boardType', async (config) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { boardRecentClimbs: [] } }), { status: 200 })),
    );
    const slot = await buildBoardSlotData({ ...config, boardId: 1, boardUuid: 'test-board' });
    expect(slot?.boardDetails).toEqual(
      getBoardImageDetailsForBoard({
        board_name: config.boardType,
        layout_id: config.layoutId,
        size_id: config.sizeId,
        set_ids: config.setIds.split(',').map(Number),
      }),
    );
    const serialized = JSON.stringify(slot?.boardDetails);
    expect(Buffer.byteLength(serialized)).toBeLessThan(700);
    expect(serialized).not.toMatch(/holdsData|images_to_holds|mirroredHoldId|"cx"|"cy"|"edge_/);
    expect(slot?.bareBoardImageUrl).toContain(`board_name=${config.boardType}`);
    expect(slot?.bareBoardImageUrl).toContain('include_background=1');
  });
});
