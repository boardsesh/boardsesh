import { describe, expect, it } from 'vitest';
import { loadBoardArtGeometry } from '@boardsesh/board-art-geometry';
import { pointInRing } from '@boardsesh/board-art-geometry/ring';
import { shardBoardForKey } from './gate-measures';

// Read-only production fixture: Et Tu, Brutus? (#4971 follow-up),
// UUID 4E562B5B2EBE45DD8DA2895A0D50467A. The fourth lit hold from the top
// is 594, a large grey hold whose upper tip touches the small hold 587.
const BRUTUS_FRAMES = 'p310r8p380r5p564r6p576r6p581r6p594r6p611r8p615r6p694r6p711r7';

describe('Tension Board 2 touching holds', () => {
  it('identifies the reported fourth hold without changing its frame ID', () => {
    const board = shardBoardForKey('tension/10-6');
    const litIds = new Set([...BRUTUS_FRAMES.matchAll(/p(\d+)r\d+/g)].map((match) => Number(match[1])));
    const topDown = board.placements.filter((hold) => litIds.has(hold.id)).sort((left, right) => left.cy - right.cy);
    expect(topDown[3].id).toBe(594);
  });

  it.each([6, 7, 8, 9, 10])('size %i keeps the large hold lobes and separates the touching neighbor', (sizeId) => {
    const board = shardBoardForKey(`tension/10-${sizeId}`);
    const geometry = loadBoardArtGeometry({ boardName: 'tension', layoutId: 10, sizeId })!;
    for (const [holdId, neighborId, direction] of [
      [594, 587, 1],
      [716, 709, -1],
    ]) {
      const hold = board.placementById.get(holdId)!;
      const neighbor = board.placementById.get(neighborId)!;
      const outline = geometry.outlines[holdId];
      // Interior landmarks on the photographed lobes, outside the old diamond.
      expect(pointInRing(outline, -0.8 * direction, -0.2), `${sizeId}/${holdId} left lobe`).toBe(true);
      expect(pointInRing(outline, 0.65 * direction, -0.45), `${sizeId}/${holdId} upper lobe`).toBe(true);
      expect(pointInRing(outline, (neighbor.cx - hold.cx) / hold.r, (neighbor.cy - hold.cy) / hold.r)).toBe(false);
      expect(pointInRing(geometry.outlines[neighborId], 0, 0)).toBe(true);
    }
  });
});
