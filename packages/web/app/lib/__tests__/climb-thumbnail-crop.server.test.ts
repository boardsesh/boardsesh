import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BoardDetails, BoardImageDetails, Climb } from '@/app/lib/types';
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/board-utils', () => ({ getBoardDetailsForBoard: vi.fn() }));
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { buildClimbThumbnailCrops } from '../climb-thumbnail-crop.server';
const board = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1],
  boardWidth: 100,
  boardHeight: 200,
  holdsData: [{ id: 1, cx: 50, cy: 50, r: 5 }],
} as BoardDetails;
const climbs = [
  { uuid: 'one', frames: 'p1r12' },
  { uuid: 'two', frames: 'p1r14' },
] as Climb[];
beforeEach(() => {
  vi.mocked(getBoardDetailsForBoard).mockReset();
});
describe('server-only thumbnail crop preparation', () => {
  it('computes geometry once per configuration and serializes only normalized crop coordinates', () => {
    vi.mocked(getBoardDetailsForBoard).mockReturnValue(board);
    const crops = buildClimbThumbnailCrops(climbs, () => board as unknown as BoardImageDetails);
    expect(getBoardDetailsForBoard).toHaveBeenCalledTimes(1);
    expect(Object.keys(crops)).toEqual(['one', 'two']);
    expect(Object.keys(crops.one)).toEqual(['x', 'y', 'width', 'height']);
    expect(JSON.stringify(crops)).not.toContain('holdsData');
  });
  it('leaves an unsupported configuration uncropped without failing the public page', () => {
    vi.mocked(getBoardDetailsForBoard).mockImplementation(() => {
      throw new Error('unknown catalogue');
    });
    expect(buildClimbThumbnailCrops(climbs, () => board as unknown as BoardImageDetails)).toEqual({});
    expect(getBoardDetailsForBoard).toHaveBeenCalledTimes(1);
  });
});
