import { describe, expect, it } from 'vite-plus/test';
import { selectCanonicalClimbAngle } from '../canonical-climb-angle';

describe('selectCanonicalClimbAngle', () => {
  it('chooses the routable angle with the most ascents', () => {
    expect(
      selectCanonicalClimbAngle({
        boardName: 'kilter',
        catalogAngle: 40,
        angleStats: [
          { angle: 40, ascensionist_count: '12' },
          { angle: 45, ascensionist_count: '20' },
        ],
      }),
    ).toBe(45);
  });

  it('keeps accepted non-picker angles eligible for the canonical', () => {
    expect(
      selectCanonicalClimbAngle({
        boardName: 'kilter',
        catalogAngle: 40,
        angleStats: [
          { angle: 40, ascensionist_count: '12' },
          { angle: 41, ascensionist_count: '20' },
        ],
      }),
    ).toBe(41);
  });

  it('prefers the catalog angle and then the lower angle on ties', () => {
    const tiedStats = [
      { angle: 35, ascensionist_count: '12' },
      { angle: 40, ascensionist_count: '12' },
    ];
    expect(selectCanonicalClimbAngle({ boardName: 'kilter', catalogAngle: 40, angleStats: tiedStats })).toBe(40);
    expect(selectCanonicalClimbAngle({ boardName: 'kilter', catalogAngle: 45, angleStats: tiedStats })).toBe(35);
  });

  it('filters unroutable stats before choosing a winner', () => {
    expect(
      selectCanonicalClimbAngle({
        boardName: 'kilter',
        catalogAngle: 40,
        angleStats: [
          { angle: -5, ascensionist_count: '100' },
          { angle: 40, ascensionist_count: '1' },
        ],
      }),
    ).toBe(40);
  });

  it('falls back to the catalog angle, then the board default', () => {
    expect(selectCanonicalClimbAngle({ boardName: 'grasshopper', catalogAngle: -5, angleStats: [] })).toBe(-5);
    expect(selectCanonicalClimbAngle({ boardName: 'kilter', catalogAngle: null, angleStats: [] })).toBe(40);
  });
});
