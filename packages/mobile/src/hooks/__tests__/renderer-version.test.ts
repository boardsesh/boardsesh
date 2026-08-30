import { describe, expect, it } from 'vitest';
import { RENDERER_VERSION, currentOverlayVersionPrefix } from '../renderer-version';

describe('RENDERER_VERSION', () => {
  it('is pinned to the exact generation this branch claims', () => {
    // Deliberately a literal, not a range. Two branches can bump this to the
    // SAME number without git ever reporting a conflict — identical lines merge
    // silently — and the one that merges second then ships new pixels under a
    // cache generation the first already spent. Nothing else in the repo would
    // go red. This assertion does, so a collision is caught in CI rather than
    // by a climber looking at a stale overlay.
    //
    // 8 belongs to the Woods work; the LED base plate took 9, and parking it again took 10.
    expect(RENDERER_VERSION).toBe(10);
  });

  it('stamps the prefix every cached overlay is matched on', () => {
    expect(currentOverlayVersionPrefix()).toBe(`v${RENDERER_VERSION}_`);
  });
});
