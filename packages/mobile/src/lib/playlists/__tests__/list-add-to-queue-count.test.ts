import { describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/queue';
import type { PlaylistRenderBoard } from '../use-playlist-render-board';

// A climb fits the active board when its own board type matches; the real
// resolver reads the board catalogue, which this rule does not need.
vi.mock('../playlist-climb-render-board', () => ({
  resolvePlaylistClimbRenderBoard: (climb: Climb, renderBoard: PlaylistRenderBoard) => ({
    renderBoard,
    incompatible: climb.boardType !== renderBoard.boardName,
  }),
}));

import { listAddToQueueCount } from '../list-add-to-queue-count';

const KILTER = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 } as PlaylistRenderBoard;
const climbOn = (boardType: string, uuid: string) => ({ uuid, boardType }) as Climb;
const ROWS = [climbOn('kilter', 'a'), climbOn('tension', 'b'), climbOn('kilter', 'c')];
const FILTERED = { unfilteredCount: 117, totalCount: 3, fitsBoard: false, hasNextPage: false, renderBoard: KILTER };

describe('listAddToQueueCount', () => {
  it('keeps the plain label while the rows are not filtered', () => {
    expect(listAddToQueueCount({ ...FILTERED, unfilteredCount: null, climbs: ROWS })).toBeUndefined();
  });

  it('takes the filtered count when every counted climb is on this board', () => {
    expect(listAddToQueueCount({ ...FILTERED, fitsBoard: true, hasNextPage: true, climbs: ROWS })).toBe(3);
  });

  it('counts the loaded climbs this board can show, once every row is loaded', () => {
    expect(listAddToQueueCount({ ...FILTERED, climbs: ROWS })).toBe(2);
    expect(listAddToQueueCount({ ...FILTERED, hasNextPage: true, climbs: ROWS })).toBeUndefined();
    expect(listAddToQueueCount({ ...FILTERED, renderBoard: null, climbs: ROWS })).toBeUndefined();
  });

  it('keeps the plain label when nothing loaded fits this board', () => {
    expect(listAddToQueueCount({ ...FILTERED, climbs: [climbOn('tension', 'b')] })).toBeUndefined();
  });
});
