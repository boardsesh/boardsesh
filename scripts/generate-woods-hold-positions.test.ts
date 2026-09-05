import { describe, expect, it } from 'vitest';
import { WOODS_ROW_LENGTHS } from '../packages/shared/board-config/src/woods-config';
import { WOODS_HOLD_POSITIONS, WOODS_OCCUPIED_HOLD_IDS } from '../packages/board-constants/src/woods';
import { calibratedWoodsPositions } from './generate-woods-hold-positions';
import { WOODS_ART_CALIBRATION } from './woods-board-calibration';

describe('reproducible Woods geometry', () => {
  it.each(['8x10', '12x12'] as const)('reproduces the committed %s positions and ownership', (size) => {
    expect(WOODS_ART_CALIBRATION[size].occupiedRows.map((row) => row.length)).toEqual(WOODS_ROW_LENGTHS[size]);
    expect(calibratedWoodsPositions(WOODS_ART_CALIBRATION[size])).toEqual({
      positions: WOODS_HOLD_POSITIONS[size],
      occupiedHoldIds: WOODS_OCCUPIED_HOLD_IDS[size],
    });
  });

  it('insets the 16-column foot row instead of stretching it to the board edges', () => {
    const { positions } = calibratedWoodsPositions(WOODS_ART_CALIBRATION['12x12']);
    expect(positions[878][0]).toBeGreaterThan(positions[861][0]);
    expect(positions[893][0]).toBeLessThan(positions[877][0]);
    expect(positions[893][0] - positions[878][0]).toBeCloseTo(1050 / 1225, 4);
  });

  it('refuses incomplete rows instead of shifting subsequent hold IDs', () => {
    expect(() => calibratedWoodsPositions({ ...WOODS_ART_CALIBRATION['8x10'], rowY: [34] })).toThrow('row counts');
  });

  it('refuses malformed ownership annotations', () => {
    expect(() =>
      calibratedWoodsPositions({ ...WOODS_ART_CALIBRATION['8x10'], rowY: [34], occupiedRows: ['10x1'] }),
    ).toThrow('occupancy');
  });

  it('rejects a shortened row before it renumbers later holds', () => {
    expect(() =>
      calibratedWoodsPositions({ ...WOODS_ART_CALIBRATION['8x10'], rowY: [34], occupiedRows: ['111'] }),
    ).toThrow('row length');
  });
});
