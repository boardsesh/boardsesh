import { describe, expect, it, vi } from 'vitest';
import type { HoldStat } from '@boardsesh/shared-schema';

vi.mock('react-native', () => ({
  StyleSheet: {
    absoluteFill: {},
    create: <Styles extends Record<string, unknown>>(styles: Styles) => styles,
  },
  View: () => null,
}));

import { buildHeatmapDiscs, heatmapRampColor } from '../HeatmapOverlay';

function holdStat(holdId: number, totalUses: number): HoldStat {
  return {
    holdId,
    totalUses,
    startingUses: 0,
    handUses: totalUses,
    footUses: 0,
    finishUses: 0,
    totalAscents: 0,
    averageDifficulty: null,
  };
}

describe('HeatmapOverlay', () => {
  it('keeps MoonBoard cell IDs and suppresses holds already painted in the editor', () => {
    const discs = buildHeatmapDiscs({
      statsByHoldId: new Map([
        [26, holdStat(26, 10)],
        [1026, holdStat(1026, 100)],
      ]),
      holdTargets: [
        { id: 26, cx: 100, cy: 200, r: 10 },
        { id: 1026, cx: 200, cy: 300, r: 10 },
      ],
      boardWidth: 400,
      boardHeight: 800,
      measuredWidth: 200,
      mirrored: false,
      paintedHoldIds: new Set([1026]),
    });

    expect(discs).toEqual([
      {
        id: 26,
        leftPct: 25,
        topPct: 25,
        diameter: 14,
        color: '#FACC15',
      },
    ]);
  });

  it('mirrors positions without changing hold identity and clamps ramp inputs', () => {
    const discs = buildHeatmapDiscs({
      statsByHoldId: new Map([[26, holdStat(26, 1)]]),
      holdTargets: [{ id: 26, cx: 100, cy: 200, r: 10 }],
      boardWidth: 400,
      boardHeight: 800,
      measuredWidth: 200,
      mirrored: true,
      paintedHoldIds: new Set(),
    });

    expect(discs[0]).toMatchObject({ id: 26, leftPct: 75, topPct: 25, color: '#EF4444' });
    expect(heatmapRampColor(-1)).toBe('#22C55E');
    expect(heatmapRampColor(2)).toBe('#EF4444');
  });
});
