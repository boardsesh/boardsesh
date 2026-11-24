import { describe, expect, it } from 'vitest';
import { formatBoardSetupSummary, formatSetupSummary } from '../setup-summary';

// Real catalogue ids: Kilter Original (1) 12×12 with kickboard (10), Bolt Ons (1)
// and Screw Ons (20); MoonBoard 2016 (2), Hold Set A (2) and B (3).
describe('setup summary', () => {
  it("joins a setup on one line in board-config's words, with the angle only when it carries one", () => {
    expect(formatSetupSummary('kilter', { layoutId: 1, sizeId: 10, setIds: '20,1' })).toBe(
      'Original · 12×12 with kickboard · Square · Bolt Ons, Screw Ons',
    );
    expect(formatSetupSummary('moonboard', { layoutId: 2, sizeId: 1, setIds: '2,3', angle: 25 })).toBe(
      '2016 · Standard · 11x18 Grid · Hold Set A, Hold Set B · 25°',
    );
  });

  it("leaves a tilting board's angle out of its own setup", () => {
    const board = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1', angle: 40 };
    expect(formatBoardSetupSummary({ ...board, isAngleAdjustable: true })).toBe(
      'Original · 12×12 with kickboard · Square · Bolt Ons',
    );
    expect(formatBoardSetupSummary({ ...board, isAngleAdjustable: false })).toBe(
      'Original · 12×12 with kickboard · Square · Bolt Ons · 40°',
    );
  });

  it('skips what the catalogue does not know, and says nothing when it knows none of it', () => {
    expect(formatSetupSummary('kilter', { layoutId: 1, sizeId: 999, setIds: '1' })).toBe('Original');
    expect(formatSetupSummary('not-a-board', { layoutId: 1, sizeId: 10, setIds: '1' })).toBeNull();
    expect(formatSetupSummary('kilter', { layoutId: 999, sizeId: 999, setIds: '999' })).toBeNull();
  });
});
