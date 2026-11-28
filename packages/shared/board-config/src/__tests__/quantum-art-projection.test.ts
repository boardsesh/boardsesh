import { describe, expect, it } from 'vitest';
import { getQuantumBundledGeometry, QUANTUM_MODELS, QUANTUM_RELEASED_MODELS } from '@boardsesh/board-constants/quantum';
import { getQuantumBoardDetails } from '../quantum-config';
import { projectQuantumBoardArtwork } from '../quantum-art-projection';

describe('projectQuantumBoardArtwork native canvas', () => {
  it.each(QUANTUM_RELEASED_MODELS)('fits %s within the GPU canvas without shifting hold silhouettes', (model) => {
    const config = QUANTUM_MODELS[model];
    const source = getQuantumBundledGeometry(config.layoutId, config.sizeId)!;
    const details = getQuantumBoardDetails({
      ...source,
      placements: source.placements.map((hold) => ({ id: hold.placementId, x: hold.x, y: hold.y })),
    })!;
    const original = projectQuantumBoardArtwork(details, { scaleCanvas: false });
    const scaled = projectQuantumBoardArtwork(details);
    const scale = Math.min(1, 1536 / original.boardWidth, 2304 / original.boardHeight);
    expect(scaled.boardWidth).toBeLessThanOrEqual(1536);
    expect(scaled.boardHeight).toBeLessThanOrEqual(2304);
    expect(Number.isInteger(scaled.boardHeight)).toBe(true);
    expect(scaled.holdsData).toHaveLength(original.holdsData.length);
    scaled.holdsData.forEach((hold, index) => {
      expect(hold.cx).toBeCloseTo(original.holdsData[index].cx * scale, 10);
      expect(hold.cy).toBeCloseTo(original.holdsData[index].cy * scale, 10);
      expect(hold.r).toBeCloseTo(original.holdsData[index].r * scale, 10);
      expect(hold.id).toBe(original.holdsData[index].id);
    });
  });
});
