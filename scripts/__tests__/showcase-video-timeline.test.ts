import { describe, expect, it } from 'vitest';
import { SHOWCASE_FPS, SHOWCASE_TAKE_IDS } from '../lib/showcase-video/contract';
import {
  DEFAULT_TAKE_SECONDS,
  SHOWCASE_OPTIONAL_TAKES,
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

  it('runs 36–42 seconds (1080–1260 frames at 30 fps)', () => {
    expect(SHOWCASE_FPS).toBe(30);
    expect(SHOWCASE_TOTAL_FRAMES).toBeGreaterThanOrEqual(1080);
    expect(SHOWCASE_TOTAL_FRAMES).toBeLessThanOrEqual(1260);
  });

  it('bakes the poster in as frame 0', () => {
    expect(SHOWCASE_POSTER_FRAME).toBe(0);
    expect(SHOWCASE_SCENES[0].id).toBe('hook');
  });

  it('alternates backgrounds, except the match cut into light and the hand-off to the end card', () => {
    const sameBackground = SHOWCASE_SCENES.slice(1).flatMap((scene, index) => {
      const previous = SHOWCASE_SCENES[index];
      return scene.background === previous.background ? [`${previous.id}→${scene.id}`] : [];
    });
    expect(sameBackground).toEqual(['hook→light', 'log→outro']);
    // The loop closes dark to dark, into the hook's poster frame.
    expect(SHOWCASE_SCENES[0].background).toBe('dark');
    expect(SHOWCASE_SCENES[SHOWCASE_SCENES.length - 1].background).toBe('dark');
  });

  it('puts callouts on both backgrounds now, and every take in exactly one scene', () => {
    const backgrounds = new Set(SHOWCASE_SCENES.filter((scene) => scene.callouts.length > 0).map((s) => s.background));
    expect(backgrounds).toEqual(new Set(['dark', 'light']));
    const takes = SHOWCASE_SCENES.flatMap((scene) => scene.takes);
    expect(new Set(takes).size).toBe(takes.length);
    expect(new Set(takes)).toEqual(new Set(SHOWCASE_TAKE_IDS));
    for (const scene of SHOWCASE_SCENES) expect(scene.callouts.length).toBeLessThanOrEqual(3);
  });

  it('lets only board phones go missing', () => {
    expect(SHOWCASE_OPTIONAL_TAKES.every((takeId) => takeId.startsWith('boards-'))).toBe(true);
    expect(SHOWCASE_OPTIONAL_TAKES).toHaveLength(8);
  });

  it('asks each take for its scene plus a second either side', () => {
    const crew = SHOWCASE_SCENES.find((scene) => scene.id === 'crew');
    if (!crew) throw new Error('crew scene missing');
    expect(requiredTakeSeconds('crew')).toBeCloseTo((crew.endFrame - crew.startFrame) / 30 + 2);
    expect(requiredTakeSeconds('nope' as never)).toBe(DEFAULT_TAKE_SECONDS);
  });
});
