import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHOWCASE_TAKE_IDS } from '../lib/showcase-video/contract';
import { buildStoreSearchArgs, parseRenderArgs } from '../lib/showcase-video/render';
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
