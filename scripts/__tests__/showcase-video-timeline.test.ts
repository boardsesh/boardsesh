import { describe, expect, it } from 'vitest';
import { SHOWCASE_FPS } from '../lib/showcase-video/contract';
import {
  SHOWCASE_POSTER_FRAME,
  SHOWCASE_SCENES,
  SHOWCASE_TOTAL_FRAMES,
  requiredTakeSeconds,
} from '../lib/showcase-video/timeline';

describe('showcase timeline', () => {
  it('starts at frame 0 and runs the scenes back to back with no gaps', () => {
    expect(SHOWCASE_SCENES[0].startFrame).toBe(0);
    SHOWCASE_SCENES.forEach((scene, index) => {
      expect(scene.endFrame).toBeGreaterThan(scene.startFrame);
      if (index > 0) expect(scene.startFrame).toBe(SHOWCASE_SCENES[index - 1].endFrame);
    });
    expect(SHOWCASE_TOTAL_FRAMES).toBe(SHOWCASE_SCENES[SHOWCASE_SCENES.length - 1].endFrame);
  });

  it('runs 18–22 seconds (540–660 frames at 30 fps)', () => {
    expect(SHOWCASE_FPS).toBe(30);
    expect(SHOWCASE_TOTAL_FRAMES).toBeGreaterThanOrEqual(540);
    expect(SHOWCASE_TOTAL_FRAMES).toBeLessThanOrEqual(660);
  });

  it('bakes the poster in as frame 0', () => {
    expect(SHOWCASE_POSTER_FRAME).toBe(0);
    expect(SHOWCASE_SCENES[0].id).toBe('hook');
  });

  it('only puts callouts on dark scenes, and every take in exactly one scene', () => {
    for (const scene of SHOWCASE_SCENES) {
      if (scene.callouts.length > 0) expect(scene.background).toBe('dark');
    }
    const takes = SHOWCASE_SCENES.flatMap((scene) => scene.takes);
    expect(new Set(takes).size).toBe(takes.length);
  });

  it('asks each take for its scene plus a second either side', () => {
    const crew = SHOWCASE_SCENES.find((scene) => scene.id === 'crew');
    if (!crew) throw new Error('crew scene missing');
    expect(requiredTakeSeconds('crew')).toBeCloseTo((crew.endFrame - crew.startFrame) / 30 + 2);
    expect(() => requiredTakeSeconds('nope' as never)).toThrow();
  });
});
