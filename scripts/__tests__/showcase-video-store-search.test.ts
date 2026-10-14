import {
  searchPhonePose,
  searchPhoneMotionPose,
  searchWordTiming,
  closerPose,
} from '../../marketing/showcase-video/anim.mjs';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHOWCASE_TAKE_IDS } from '../lib/showcase-video/contract';
import {
  buildStoreSearchArgs,
  parseRenderArgs,
  parseHeadline,
  storeSearchCrewPhonePose,
  SHOWCASE_PHONE,
  screenToCanvas,
} from '../lib/showcase-video/render';
import {
  creativeVideoProblems,
  storeSearchTarget,
  targetOutputs,
  targetSeconds,
  type ProbedMedia,
} from '../lib/showcase-video/targets';
import { resolveTimeline } from '../lib/showcase-video/timeline';
import {
  STORE_SEARCH_LOCALES,
  STORE_SEARCH_VARIANTS,
  storeSearchCopyPath,
  storeSearchCopyProblems,
  storeSearchPlan,
  storeSearchRecordingProblems,
  type StoreSearchCopy,
} from '../lib/showcase-video/store-search';

const validMedia: ProbedMedia = {
  durationSeconds: 20,
  sizeBytes: 10_000_000,
  video: { codec: 'h264', profile: 'High', level: 50, width: 1920, height: 1280, fps: 30, kbps: 4000 },
  audio: null,
};

describe('Apple search video', () => {
  it('uses High level 5.0, exactly 30 fps, and no audio', () => {
    const args = buildStoreSearchArgs('input.mkv', 'output.mp4');
    expect(args[args.indexOf('-profile:v') + 1]).toBe('high');
    expect(args[args.indexOf('-level:v') + 1]).toBe('5.0');
    expect(args[args.indexOf('-r') + 1]).toBe('30');
    expect(args).toContain('-an');
    expect(creativeVideoProblems(validMedia)).toEqual([]);
    expect(creativeVideoProblems({ ...validMedia, video: { ...validMedia.video!, level: 40 } })).toContain(
      'H.264 level 4, below 5.0',
    );
    expect(creativeVideoProblems({ ...validMedia, video: { ...validMedia.video!, fps: 60 } })).toContain(
      '60 fps, not 30',
    );
    expect(
      creativeVideoProblems({ ...validMedia, audio: { codec: 'aac', channels: 2, sampleRate: 48000, kbps: 128 } }),
    ).toContain('search creative must have no audio track');
    expect(creativeVideoProblems({ ...validMedia, durationSeconds: 31 })).not.toEqual([]);
  });

  it('routes every locale and variant to its own native asset directory', () => {
    for (const locale of STORE_SEARCH_LOCALES)
      for (const variant of STORE_SEARCH_VARIANTS) {
        const target = storeSearchTarget(locale, variant);
        expect(targetSeconds(target)).toBe(variant === 'default' ? 20 : 15);
        expect(targetOutputs(target)[0]).toContain(`/app-store-creatives/${variant}/${locale}/search-results.mp4`);
        expect(target.donationLine).toBe(false);
        expect(target.audio).toEqual({ kind: 'none' });
        expect(target.storeSearch?.crossfadeFrames).toBe(15);
        expect(target.renditions[0].size).toEqual({ width: 1920, height: 1280 });
      }
    expect(parseRenderArgs(['--target', 'store-search', '--variant', 'tension', '--locale', 'all'])).toMatchObject({
      variant: 'tension',
      locales: STORE_SEARCH_LOCALES,
    });
    expect(() => parseRenderArgs(['--locale', 'it'])).toThrow(/locale/);
  });

  it('rejects stale, English, unvalidated, and wrong-board recording provenance', () => {
    const metadata = {
      takeId: 'crew',
      locale: 'fr',
      kind: 'tension',
      platform: 'ios',
      recordedAt: '2026-10-13T00:00:00Z',
      validated: true,
    };
    expect(storeSearchRecordingProblems(metadata, 'crew', 'fr', 'tension')).toEqual([]);
    expect(storeSearchRecordingProblems({ ...metadata, locale: 'en-US' }, 'crew', 'fr', 'tension')).not.toEqual([]);
    expect(storeSearchRecordingProblems({ ...metadata, kind: 'kilter' }, 'crew', 'fr', 'tension')).not.toEqual([]);
    expect(storeSearchRecordingProblems({ ...metadata, validated: false }, 'crew', 'fr', 'tension')).not.toEqual([]);
    expect(storeSearchRecordingProblems({}, 'crew', 'fr', 'tension')).toHaveLength(6);
  });

  it('drops unavailable new MoonBoard beats without showing Kilter takes', () => {
    const available = new Set(
      SHOWCASE_TAKE_IDS.filter((takeId) => !['moonboard-import', 'moonboard-filter', 'crew'].includes(takeId)),
    );
    const timeline = resolveTimeline(available, storeSearchPlan('moonboard'));
    expect(timeline.scenes.map((scene) => scene.caption)).toEqual(['moonboard', 'outro']);
    expect(timeline.scenes.flatMap((scene) => scene.takes)).toEqual(['boards-moonboard']);
    for (const variant of ['tension', 'moonboard'] as const) {
      expect(storeSearchPlan(variant).flatMap((scene) => scene.takes ?? [])).not.toContain('boards-kilter');
    }
  });

  it('keeps localized captions brief and manufacturer names out of generic captions', () => {
    const expectedKeys = Object.keys(
      JSON.parse(readFileSync(storeSearchCopyPath('en-US'), 'utf8')) as StoreSearchCopy,
    ).sort();
    for (const locale of STORE_SEARCH_LOCALES) {
      const copy = JSON.parse(readFileSync(storeSearchCopyPath(locale), 'utf8')) as StoreSearchCopy;
      expect(Object.keys(copy).sort()).toEqual(expectedKeys);
      expect(storeSearchCopyProblems(copy), locale).toEqual([]);
      for (const variant of STORE_SEARCH_VARIANTS) {
        for (const scene of storeSearchPlan(variant))
          expect(copy[scene.caption!], `${locale}/${scene.caption}`).toBeTruthy();
        const timeline = resolveTimeline(new Set(SHOWCASE_TAKE_IDS), storeSearchPlan(variant));
        expect(timeline.scenes.every((scene) => scene.background === 'dark' && scene.callouts.length === 0)).toBe(true);
      }
      expect(copy.boards).not.toMatch(/Kilter|Tension|MoonBoard/);
    }
  });
});

describe('store search crew framing', () => {
  const canvas = { width: 1920, height: 1280 };
  const safeArea = { top: 120, bottom: 120, left: 120, right: 120 };

  it('fits the complete phone beside the caption without cropping the bottom queue rows', () => {
    const pose = storeSearchCrewPhonePose(SHOWCASE_PHONE, canvas, safeArea);
    const halfWidth = (SHOWCASE_PHONE.width * pose.scale) / 2;
    const halfHeight = (SHOWCASE_PHONE.height * pose.scale) / 2;
    expect(pose.cy - halfHeight).toBeGreaterThanOrEqual(safeArea.top);
    expect(pose.cy + halfHeight).toBeLessThanOrEqual(canvas.height - safeArea.bottom);
    expect(pose.cx - halfWidth).toBeGreaterThan(120 + 740);
    expect(pose.cx + halfWidth).toBeLessThanOrEqual(canvas.width - safeArea.right);
    expect(pose.scale).toBeGreaterThan(1);
    expect(pose.scale).toBeLessThan(1.6);
    expect([pose.rx, pose.ry, pose.rz]).toEqual([0, 0, 0]);
  });

  it('keeps even the bottom-most native avatar and menu pixels inside the stage safe area', () => {
    const pose = storeSearchCrewPhonePose(SHOWCASE_PHONE, canvas, safeArea);
    const screen = { width: 440, height: 956 };
    // Stronger than any particular row position: every native pixel, including
    // a peer avatar at the bottom edge of a dynamic queue sheet, remains visible.
    const bottomAvatar = screenToCanvas({ x: 360, y: 936, width: 20, height: 20 }, screen, pose, canvas);
    const bottomMenu = screenToCanvas({ x: 0, y: 910, width: 440, height: 46 }, screen, pose, canvas);
    for (const rect of [bottomAvatar, bottomMenu]) {
      expect(rect.y).toBeGreaterThanOrEqual(safeArea.top);
      expect(rect.y + rect.height).toBeLessThanOrEqual(canvas.height - safeArea.bottom);
      expect(rect.x).toBeGreaterThan(120 + 740);
      expect(rect.x + rect.width).toBeLessThanOrEqual(canvas.width - safeArea.right);
    }
  });

  it('fits every crew caption while keeping non-crew framing and loop painting unchanged', () => {
    const timeline = readFileSync(new URL('../../marketing/showcase-video/timeline.mjs', import.meta.url), 'utf8');
    const defaultPose = { cx: 1420, cy: 910, scale: 1.6, rx: 0, ry: 0, rz: 0 };
    const crewPose = storeSearchCrewPhonePose(SHOWCASE_PHONE, canvas, safeArea);
    const fittedCaptions = new Set<string>();
    for (const variant of STORE_SEARCH_VARIANTS) {
      const scenes = resolveTimeline(new Set(SHOWCASE_TAKE_IDS), storeSearchPlan(variant)).scenes;
      for (const scene of scenes) {
        const renderedPose = searchPhonePose(scene.takes[0], scene.takes.length, defaultPose, crewPose);
        if (scene.takes.length === 1 && scene.takes[0] === 'crew') {
          fittedCaptions.add(scene.caption ?? '');
          expect(renderedPose).toBe(crewPose);
        } else {
          expect(renderedPose).toBe(defaultPose);
        }
      }
    }
    expect([...fittedCaptions].sort()).toEqual(['crew', 'friends', 'tensionFriends']);
    expect(searchPhonePose('boards-kilter', 1, defaultPose, crewPose)).toBe(defaultPose);
    expect(searchPhonePose('crew', 2, defaultPose, crewPose)).toBe(defaultPose);
    expect(searchPhonePose('crew', 1, defaultPose, undefined)).toBe(defaultPose);
    expect(timeline).toContain('const slot = searchPhonePose(');
    expect(timeline).toContain('paintSearchScene(opening, 0, frame)');
    expect(timeline).toContain("cy: single ? (scene.id === 'lock-screen' ? 925 : 910) : 820");
    expect(timeline).toContain('scale: single ? 1.6 : index === Math.floor(count / 2) ? 1.12 : 0.92');
  });
});

describe('hero motion for store search', () => {
  const slot = { cx: 1420, cy: 640, scale: 1.15, rx: 0, ry: 0, rz: 0 };

  it('leads the beat with a spring then keeps the real peer row settled until the exit', () => {
    const off = searchPhoneMotionPose(slot, -12, 90);
    const arriving = searchPhoneMotionPose(slot, -6, 90);
    expect(off.cx).toBeGreaterThan(1920);
    expect(arriving.cx).not.toBe(off.cx);
    for (const frame of [0, 1, 12, 40, 77]) expect(searchPhoneMotionPose(slot, frame, 90)).toEqual(slot);
    expect(searchPhoneMotionPose(slot, 83, 90).cx).toBeGreaterThan(slot.cx);
    expect(searchPhoneMotionPose(slot, 89, 90).cx).toBeGreaterThan(1920);
    // No clamped spring residual jumps at the entrance endpoint.
    expect(Math.abs(searchPhoneMotionPose(slot, -0.00001, 90).cx - slot.cx)).toBeLessThan(0.001);
  });

  it('keeps the opening readable and stationary instead of replaying an entrance after frame zero', () => {
    for (const frame of [0, 1, 10, 40, 77]) {
      expect(searchPhoneMotionPose(slot, frame, 90, { opening: true })).toEqual(slot);
    }
    expect(searchPhoneMotionPose(slot, 83, 90, { opening: true })).not.toEqual(slot);
  });

  it('staggers board phones in two dimensions and never adds a tilt', () => {
    const first = searchPhoneMotionPose(slot, -10, 90, { index: 0, count: 3 });
    const middle = searchPhoneMotionPose(slot, -10, 90, { index: 1, count: 3 });
    const last = searchPhoneMotionPose(slot, -10, 90, { index: 2, count: 3 });
    expect(first.cy).not.toBe(middle.cy);
    expect(last.cx).toBeGreaterThan(1920);
    for (let index = 0; index < 3; index++) {
      for (const frame of [-12, -6, 0, 10, 78, 89]) {
        const pose = searchPhoneMotionPose(slot, frame, 90, { index, count: 3 });
        expect([pose.rx, pose.ry, pose.rz]).toEqual([0, 0, 0]);
        if (frame === 0) expect(pose).toEqual(slot);
      }
    }
  });

  it('makes every locale caption fully readable by frame ten, including the accent', () => {
    for (const locale of STORE_SEARCH_LOCALES) {
      const copy = JSON.parse(readFileSync(storeSearchCopyPath(locale), 'utf8')) as StoreSearchCopy;
      for (const caption of Object.values(copy)) {
        const regularCount = parseHeadline(caption)
          .flat()
          .filter((word) => !word.accent).length;
        for (const deadline of [10, 7]) {
          const timing = searchWordTiming(regularCount, deadline);
          const lastRegular = timing.firstWord + timing.wordStagger * Math.max(0, regularCount - 1);
          expect(lastRegular + timing.wordFrames).toBeLessThanOrEqual(deadline);
          expect(lastRegular + timing.accentDelay + timing.accentFrames).toBeLessThanOrEqual(deadline);
        }
      }
    }
    const css = readFileSync(new URL('../../marketing/showcase-video/scenes.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/\.search-caption \.w\s*\{/);
  });

  it('lands the hero loop rise exactly on the original phone without an empty last frame', () => {
    expect(closerPose(slot, 435, 435, 449, 1280)).not.toEqual(slot);
    expect(closerPose(slot, 449, 435, 449, 1280)).toEqual(slot);
  });
});
