import { describe, expect, it } from 'vitest';
import { loadBoardArtGeometry } from '@boardsesh/board-art-geometry/loader';
import { placementsWithoutOwnPhotoBody } from '@boardsesh/board-art-geometry/segmentation';
import { containsPoint, loadBoardArtLayers, shardBoardForKey, toTracerPixels } from './gate-measures';

const CASES = [
  ['quantum/9101-9201', [1002077, 1003056, 1006087, 1006109]],
  ['quantum/9101-9202', [1002077, 1003056, 1006087, 1006109]],
  ['quantum/9101-9203', [1003056, 1006087, 1006109]],
  ['quantum/9104-9204', []],
] as const;

describe('Quantum photo body ownership', () => {
  it.each(CASES)('%s leaves unsupported logical slots untraced', async (key, expected) => {
    const board = shardBoardForKey(key);
    const [art] = await loadBoardArtLayers(board);
    const unsupported = placementsWithoutOwnPhotoBody(art.opaque, art.width, art.height, board.placements);
    expect([...unsupported].sort((left, right) => left - right)).toEqual(expected);
    const geometry = loadBoardArtGeometry(board)!;
    for (const placementId of unsupported) expect(geometry.outlines[placementId]).toBeUndefined();
  });

  it.each(['quantum/9101-9201', 'quantum/9101-9202', 'quantum/9101-9203'])(
    '%s restores broad hold lobes instead of cutting wedges',
    (key) => {
      const board = shardBoardForKey(key);
      const geometry = loadBoardArtGeometry(board)!;
      for (const [placementId, dx, dy] of [
        [1003058, -38, 32],
        [1003058, -40, -10],
        [1003058, 35, -35],
        [1006083, 35, -35],
        [1006112, -38, 32],
        [1003063, 10, 15],
        [1003063, 0, -20],
        [1006086, -40, -10],
        [1006086, 40, 0],
      ]) {
        const placement = board.placementById.get(placementId)!;
        const pixels = toTracerPixels(geometry.outlines[placementId], placement);
        expect([key, placementId, containsPoint(pixels, dx, dy)]).toEqual([key, placementId, true]);
      }
      const small = board.placementById.get(1006094)!;
      const smallPixels = toTracerPixels(geometry.outlines[small.id], small);
      expect(containsPoint(smallPixels, 0, 40)).toBe(false);
    },
  );
});
