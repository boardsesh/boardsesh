import { describe, expect, it } from 'vite-plus/test';
import { boardRows as nodeBoardRows, GRID_POSITIONS_BY_ROWS as nodeGridPositions } from '@boardsesh/moonboard-ocr';
import {
  boardRows as browserBoardRows,
  GRID_POSITIONS_BY_ROWS as browserGridPositions,
} from '@boardsesh/moonboard-ocr/browser';

describe.each([
  { entry: 'root', boardRows: nodeBoardRows, gridPositions: nodeGridPositions },
  { entry: 'browser', boardRows: browserBoardRows, gridPositions: browserGridPositions },
])('$entry package consumer', ({ boardRows, gridPositions }) => {
  it('can use the documented grid helper for both Minis and the legacy default', () => {
    expect(Object.keys(gridPositions[boardRows()])).toHaveLength(198);
    for (const holdsetup of [19, 22] as const) {
      const positions = gridPositions[boardRows(holdsetup)];
      expect(Object.keys(positions)).toHaveLength(132);
      expect(positions.A12).toBeDefined();
      expect(positions.A13).toBeUndefined();
    }
  });
});
