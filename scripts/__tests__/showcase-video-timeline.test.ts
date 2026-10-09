import { describe, expect, it } from 'vitest';
import { SHOWCASE_FPS, SHOWCASE_TAKE_IDS } from '../lib/showcase-video/contract';
import {
  DEFAULT_TAKE_SECONDS,
  SHOWCASE_OPTIONAL_TAKES,
  SHOWCASE_POSTER_FRAME,
  SHOWCASE_SKIPPABLE_SCENES,
  SHOWCASE_SCENES,
  SHOWCASE_TOTAL_FRAMES,
  requiredTakeSeconds,
  resolveTimeline,
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

  it('runs 50–60 seconds (1500–1800 frames at 30 fps; 60 s is the hard cap)', () => {
    expect(SHOWCASE_FPS).toBe(30);
    expect(SHOWCASE_TOTAL_FRAMES).toBeGreaterThanOrEqual(1500);
    expect(SHOWCASE_TOTAL_FRAMES).toBeLessThanOrEqual(1800);
  });

  it('bakes the poster in as frame 0', () => {
    expect(SHOWCASE_POSTER_FRAME).toBe(0);
    expect(SHOWCASE_SCENES[0].id).toBe('boards');
  });

  it('runs boards, the spray wall, then the feature scenes: 1644 frames, 54.8 s', () => {
    expect(SHOWCASE_SCENES.map((scene) => [scene.id, scene.endFrame - scene.startFrame])).toEqual([
      ['boards', 156],
      ['spray', 180],
      ['wall', 270],
      ['crew', 282],
      ['workouts', 168],
      ['lock-screen', 180],
      ['log', 216],
      ['outro', 192],
    ]);
    expect(SHOWCASE_TOTAL_FRAMES).toBe(1644);
    expect(SHOWCASE_TOTAL_FRAMES / SHOWCASE_FPS).toBeCloseTo(54.8);
  });

  it('alternates backgrounds from the first scene, except the hand-off to the end card', () => {
    const sameBackground = SHOWCASE_SCENES.slice(1).flatMap((scene, index) => {
      const previous = SHOWCASE_SCENES[index];
      return scene.background === previous.background ? [`${previous.id}→${scene.id}`] : [];
    });
    expect(sameBackground).toEqual(['log→outro']);
    expect(SHOWCASE_SCENES.map((scene) => scene.background)).toEqual([
      'dark',
      'light',
      'dark',
      'light',
      'dark',
      'light',
      'dark',
      'dark',
    ]);
    // The loop closes dark to dark, into the boards scene's poster frame.
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

  it('lets only board phones and the island take go missing', () => {
    expect(SHOWCASE_OPTIONAL_TAKES.filter((takeId) => !takeId.startsWith('boards-'))).toEqual(['lock-screen']);
    expect(SHOWCASE_OPTIONAL_TAKES).toHaveLength(10);
    // The spray scene is not skippable: its take is required.
    expect(SHOWCASE_OPTIONAL_TAKES).not.toContain('spray');
    expect(SHOWCASE_SKIPPABLE_SCENES).toEqual(['lock-screen']);
  });

  it('is the full storyboard when every take is there', () => {
    const timeline = resolveTimeline(new Set(SHOWCASE_TAKE_IDS));
    expect(timeline.scenes).toEqual(SHOWCASE_SCENES);
    expect(timeline.totalFrames).toBe(SHOWCASE_TOTAL_FRAMES);
    expect(timeline.skipped).toEqual([]);
  });

  it('drops the island scene without its take, closes up, and still alternates backgrounds (~49 s)', () => {
    const timeline = resolveTimeline(new Set(SHOWCASE_TAKE_IDS.filter((takeId) => takeId !== 'lock-screen')));
    expect(timeline.skipped).toEqual(['lock-screen']);
    expect(timeline.scenes.map((scene) => scene.id)).not.toContain('lock-screen');
    const island = SHOWCASE_SCENES.find((scene) => scene.id === 'lock-screen');
    if (!island) throw new Error('island scene missing');
    expect(timeline.totalFrames).toBe(SHOWCASE_TOTAL_FRAMES - (island.endFrame - island.startFrame));
    expect(timeline.totalFrames / 30).toBeGreaterThan(45);
    timeline.scenes.forEach((scene, index) => {
      if (index > 0) expect(scene.startFrame).toBe(timeline.scenes[index - 1].endFrame);
    });
    const sameBackground = timeline.scenes.slice(1).flatMap((scene, index) => {
      const previous = timeline.scenes[index];
      return scene.background === previous.background ? [`${previous.id}→${scene.id}`] : [];
    });
    expect(sameBackground).toEqual([]);
    expect(timeline.totalFrames).toBe(1464);
    expect(timeline.scenes.find((scene) => scene.id === 'log')?.background).toBe('light');
  });

  it('alternates dark and light from the first scene of any plan; the last scene keeps its own', () => {
    const every = new Set(SHOWCASE_TAKE_IDS);
    const reel = resolveTimeline(every, [
      { id: 'boards' },
      { id: 'spray' },
      { id: 'crew' },
      { id: 'lock-screen', frames: 150 },
      { id: 'outro', frames: 129 },
    ]);
    expect(reel.scenes.map((scene) => [scene.id, scene.background])).toEqual([
      ['boards', 'dark'],
      ['spray', 'light'],
      ['crew', 'dark'],
      ['lock-screen', 'light'],
      ['outro', 'dark'],
    ]);
    const play = resolveTimeline(every, [
      { id: 'boards' },
      { id: 'spray' },
      { id: 'crew' },
      { id: 'lock-screen' },
      { id: 'log' },
      { id: 'outro', frames: 129 },
    ]);
    expect(play.scenes.map((scene) => [scene.id, scene.background])).toEqual([
      ['boards', 'dark'],
      ['spray', 'light'],
      ['crew', 'dark'],
      ['lock-screen', 'light'],
      ['log', 'dark'],
      ['outro', 'dark'],
    ]);
    // An odd scene before the end card would otherwise meet it light on dark, which is fine: only the
    // last scene is pinned.
    const short = resolveTimeline(every, [{ id: 'boards' }, { id: 'spray' }, { id: 'outro' }]);
    expect(short.scenes.map((scene) => scene.background)).toEqual(['dark', 'light', 'dark']);
  });

  it('asks each take for its scene plus a second either side', () => {
    const crew = SHOWCASE_SCENES.find((scene) => scene.id === 'crew');
    if (!crew) throw new Error('crew scene missing');
    expect(requiredTakeSeconds('crew')).toBeCloseTo((crew.endFrame - crew.startFrame) / 30 + 2);
    expect(requiredTakeSeconds('nope' as never)).toBe(DEFAULT_TAKE_SECONDS);
  });
});
