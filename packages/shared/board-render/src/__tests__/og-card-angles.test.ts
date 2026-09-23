import { ANGLES } from '@boardsesh/board-config';
import { describe, expect, it } from 'vitest';
import { ogClimbQuerySchema } from '../validation';

const validQuery = {
  board_name: 'kilter',
  layout_id: '1',
  size_id: '10',
  set_ids: '1,20',
  frames: 'p1080r15',
};

/**
 * Every angle a board offers has to survive the card's query schema. A rejected
 * angle is a 400, and a 400 is not a card missing its angle chip — it is no card
 * at all for every climb whose canonical angle is that one.
 *
 * Grasshopper is why this exists: its list starts at -5, and the first bound
 * here was `min(0)`.
 */
describe('every board angle reaches the card', () => {
  const angles = Object.entries(ANGLES).flatMap(([boardName, list]) => list.map((angle) => ({ boardName, angle })));

  it('covers every board', () => {
    expect(Object.keys(ANGLES).length).toBeGreaterThan(5);
    expect(angles.length).toBeGreaterThan(50);
  });

  it('accepts all of them', () => {
    const rejected = angles.filter(
      ({ angle }) => !ogClimbQuerySchema.safeParse({ ...validQuery, angle: String(angle) }).success,
    );

    expect(rejected.map(({ boardName, angle }) => `${boardName} ${angle}°`)).toEqual([]);
  });

  it('still refuses an angle no board has', () => {
    for (const angle of ['91', '-91', '1000']) {
      expect(ogClimbQuerySchema.safeParse({ ...validQuery, angle }).success, angle).toBe(false);
    }
  });
});
