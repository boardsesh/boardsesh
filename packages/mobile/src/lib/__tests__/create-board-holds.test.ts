import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../board-details', () => ({
  getBoardRenderData: vi.fn(),
}));

import { getBoardRenderData } from '../board-details';
import { getCreateBoardHolds } from '../create-board-holds';

const mockedGetBoardRenderData = vi.mocked(getBoardRenderData);

describe('getCreateBoardHolds', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns MoonBoard hold targets and family from MoonBoard grid data', () => {
    const result = getCreateBoardHolds({
      boardName: 'moonboard',
      layoutId: 3,
      sizeId: 1,
      setIds: [8],
    });

    expect(result?.family).toBe('moonboard');
    expect(result?.boardWidth).toBe(650);
    expect(result?.boardHeight).toBe(1000);
    expect(result?.holdTargets).toHaveLength(198);

    const firstHold = result?.holdTargets[0];
    expect(firstHold?.id).toBe(1);
    expect(firstHold?.cx).toBeCloseTo(90.1136, 4);
    expect(firstHold?.cy).toBeCloseTo(935, 4);
    expect(firstHold?.r).toBeCloseTo(19.4444, 4);

    const lastHold = result?.holdTargets.at(-1);
    expect(lastHold?.id).toBe(198);
    expect(lastHold?.cx).toBeCloseTo(592.3864, 4);
    expect(lastHold?.cy).toBeCloseTo(85, 4);
    expect(lastHold?.r).toBeCloseTo(19.4444, 4);
    expect(mockedGetBoardRenderData).not.toHaveBeenCalled();
  });

  it('returns null when MoonBoard grid data is unavailable', () => {
    mockedGetBoardRenderData.mockReturnValue(null);

    expect(
      getCreateBoardHolds({
        boardName: 'moonboard',
        layoutId: 999,
        sizeId: 1,
        setIds: [8],
      }),
    ).toBeNull();
  });
});
