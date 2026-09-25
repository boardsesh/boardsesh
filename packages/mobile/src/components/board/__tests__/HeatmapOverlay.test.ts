import { describe, expect, it, vi } from 'vitest';
import type { HoldStat } from '@boardsesh/shared-schema';

vi.mock('react-native', () => ({
  StyleSheet: {
    absoluteFill: {},
    create: <Styles extends Record<string, unknown>>(styles: Styles) => styles,
  },
  View: () => null,
}));

import { buildHeatmapDiscs, HEAT_RAMP, heatmapRampColor } from '../HeatmapOverlay';

const [COOLEST, , MIDDLE, , HOTTEST] = HEAT_RAMP;

function holdStat(holdId: number, overrides: Partial<HoldStat> = {}): HoldStat {
  return {
    holdId,
    totalUses: 1,
    startingUses: 0,
    handUses: 1,
    footUses: 0,
    finishUses: 0,
    totalAscents: 0,
    averageDifficulty: null,
    ...overrides,
  };
}

const targets = [
  { id: 26, cx: 100, cy: 200, r: 10 },
  { id: 27, cx: 200, cy: 300, r: 10 },
  { id: 28, cx: 300, cy: 400, r: 10 },
];
const geometry = { holdTargets: targets, boardWidth: 400, boardHeight: 800, measuredWidth: 200 };

describe('buildHeatmapDiscs', () => {
  it('colours by uses on a log scale and positions discs on the renderer targets', () => {
    const discs = buildHeatmapDiscs({
      ...geometry,
      statsByHoldId: new Map([
        [26, holdStat(26, { totalUses: 10 })],
        [27, holdStat(27, { totalUses: 100 })],
      ]),
    });

    expect(discs).toEqual([
      // log1p(10) / log1p(100) ≈ 0.52 → the middle of the ramp.
      { id: 26, leftPct: 25, topPct: 25, diameter: 14, color: MIDDLE },
      { id: 27, leftPct: 50, topPct: 37.5, diameter: 14, color: HOTTEST },
    ]);
  });

  it('suppresses holds already painted on the create board', () => {
    const discs = buildHeatmapDiscs({
      ...geometry,
      statsByHoldId: new Map([
        [26, holdStat(26, { totalUses: 10 })],
        [27, holdStat(27, { totalUses: 100 })],
      ]),
      paintedHoldIds: new Set([27]),
    });

    // The painted hold drops out of the scale too, so the remaining hold is the hottest.
    expect(discs).toEqual([{ id: 26, leftPct: 25, topPct: 25, diameter: 14, color: HOTTEST }]);
  });

  it('mirrors positions without changing hold identity', () => {
    const discs = buildHeatmapDiscs({
      ...geometry,
      statsByHoldId: new Map([[26, holdStat(26)]]),
      mirrored: true,
    });

    expect(discs[0]).toMatchObject({ id: 26, leftPct: 75, topPct: 25 });
  });

  it('colours by ascents and skips holds whose climbs have none', () => {
    const discs = buildHeatmapDiscs({
      ...geometry,
      mode: 'ascents',
      statsByHoldId: new Map([
        [26, holdStat(26, { totalUses: 50, totalAscents: 0 })],
        [27, holdStat(27, { totalUses: 1, totalAscents: 900 })],
      ]),
    });

    expect(discs.map((disc) => [disc.id, disc.color])).toEqual([[27, HOTTEST]]);
  });

  it('spreads difficulty linearly across the grades on screen, easy green to hard red', () => {
    const discs = buildHeatmapDiscs({
      ...geometry,
      mode: 'difficulty',
      statsByHoldId: new Map([
        [26, holdStat(26, { averageDifficulty: 16 })],
        [27, holdStat(27, { averageDifficulty: 20 })],
        [28, holdStat(28, { averageDifficulty: 24 })],
      ]),
    });

    expect(discs.map((disc) => disc.color)).toEqual([COOLEST, MIDDLE, HOTTEST]);
  });

  it('puts a single difficulty in the middle and skips ungraded holds', () => {
    const discs = buildHeatmapDiscs({
      ...geometry,
      mode: 'difficulty',
      statsByHoldId: new Map([
        [26, holdStat(26, { averageDifficulty: 18 })],
        [27, holdStat(27, { averageDifficulty: null })],
      ]),
    });

    expect(discs.map((disc) => [disc.id, disc.color])).toEqual([[26, MIDDLE]]);
  });

  it('draws nothing before the board has been measured', () => {
    expect(buildHeatmapDiscs({ ...geometry, measuredWidth: 0, statsByHoldId: new Map([[26, holdStat(26)]]) })).toEqual(
      [],
    );
  });

  it('clamps ramp inputs', () => {
    expect(heatmapRampColor(-1)).toBe(COOLEST);
    expect(heatmapRampColor(2)).toBe(HOTTEST);
    expect(heatmapRampColor(Number.NaN)).toBe(COOLEST);
  });
});
