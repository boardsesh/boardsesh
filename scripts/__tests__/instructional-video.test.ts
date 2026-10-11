import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTutorialArguments } from '../instructional-video';
import { EVERGREEN_EPISODE, validateTutorialEpisode } from '../lib/instructional-video/episodes';
import { tutorialMixArgs } from '../lib/instructional-video/media';
import {
  buildTutorialCuts,
  readTutorialTake,
  selectedChapters,
  sourceFrameIndex,
  tutorialRecordingPack,
  tutorialWebVtt,
  voicePath,
} from '../lib/instructional-video/timeline';
import type { TutorialTakeManifest } from '../lib/instructional-video/types';

const temporaryDirectories: string[] = [];
const temporaryDirectory = (): string => {
  const directory = mkdtempSync(resolve(tmpdir(), 'boardsesh-tutorial-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

const manifest: TutorialTakeManifest = {
  formatVersion: 1,
  takeId: 'crew',
  platform: 'android',
  fps: 30,
  width: 1080,
  height: 2424,
  screen: { width: 411.4286, height: 923.4286 },
  frameCount: 600,
  seconds: 20,
  sourceCommit: 'reviewed-source',
  nativeArtifactSha256: 'a'.repeat(64),
  fingerprint: 'b'.repeat(64),
  marks: { invite: 2, contribution: 8 },
  anchors: {},
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('instructional video delivery timing', () => {
  it('keeps the evergreen master, overview and chapter cuts within the agreed lengths', () => {
    const cuts = buildTutorialCuts(EVERGREEN_EPISODE);
    expect(cuts.map((cut) => cut.id)).toEqual([
      'master',
      'overview',
      'crew',
      'workouts',
      'search',
      'spray',
      'progress',
    ]);
    expect(cuts.find((cut) => cut.id === 'master')!.totalFrames / 30).toBe(149);
    expect(cuts.find((cut) => cut.id === 'overview')!.totalFrames / 30).toBe(55);
    expect(cuts.filter((cut) => cut.kind === 'chapter').every((cut) => cut.totalFrames / 30 === 31)).toBe(true);
    expect(cuts[0].beats).toHaveLength(20);
  });

  it('retimes every later beat and subtitle when one human clip runs longer', () => {
    const voice = { path: '/recordings/crew-invite.wav', seconds: 9.17, sha256: 'voice-hash' };
    const cut = buildTutorialCuts(EVERGREEN_EPISODE, new Map([['crew-invite', voice]]), ['crew'])[0];
    expect(cut.beats[0].frames).toBe(283);
    expect(cut.beats[1].startFrame).toBe(cut.introFrames + 283);
    expect(cut.beats[1].voice).toBeUndefined();
    expect(tutorialWebVtt(cut)).toContain('00:00:01.500 --> 00:00:10.933');
    expect(tutorialWebVtt(cut)).toContain('00:00:10.933 --> 00:00:17.933');
  });

  it('rejects invalid speech durations and speech that makes delivery too long', () => {
    for (const seconds of [0, Number.NaN, Number.POSITIVE_INFINITY, 30.01]) {
      expect(() =>
        buildTutorialCuts(
          EVERGREEN_EPISODE,
          new Map([['crew-invite', { path: 'voice.wav', seconds, sha256: 'hash' }]]),
          ['crew'],
        ),
      ).toThrow('Recording crew-invite');
    }
    const longRecordings = new Map(
      EVERGREEN_EPISODE.chapters.flatMap((chapter) =>
        chapter.beats.map((beat) => [beat.id, { path: `${beat.id}.wav`, seconds: 12, sha256: 'hash' }] as const),
      ),
    );
    expect(() => buildTutorialCuts(EVERGREEN_EPISODE, longRecordings)).toThrow('requires 120–180');
  });

  it('renders only named chapters in the supplied order without changing other cuts', () => {
    expect(buildTutorialCuts(EVERGREEN_EPISODE, new Map(), ['spray', 'crew']).map((cut) => cut.id)).toEqual([
      'spray',
      'crew',
    ]);
    for (const chapterIds of [[], ['crew', 'crew'], ['missing']])
      expect(() => selectedChapters(EVERGREEN_EPISODE, chapterIds)).toThrow();
  });

  it('holds the last demonstrated frame instead of showing the next unrelated action', () => {
    const beat = EVERGREEN_EPISODE.chapters[0].beats[0];
    expect(sourceFrameIndex(beat, manifest, 0)).toBe(60);
    expect(sourceFrameIndex(beat, manifest, 7 * 30)).toBe(239);
    expect(sourceFrameIndex({ ...beat, toMark: 'contribution' }, manifest, 1000)).toBe(239);
    expect(() => sourceFrameIndex({ ...beat, fromMark: 'absent' }, manifest, 0)).toThrow('missing a valid mark');
    expect(() => sourceFrameIndex({ ...beat, toMark: 'absent' }, manifest, 0)).toThrow('invalid ending mark');
  });
});

describe('instructional video inputs and final audio gates', () => {
  it('writes one recording prompt for each of the 20 teaching beats', () => {
    const pack = tutorialRecordingPack(EVERGREEN_EPISODE);
    const filenames = [...pack.matchAll(/\*\*([a-z0-9-]+\.wav)\*\*/g)].map((match) => match[1]);
    expect(filenames).toHaveLength(20);
    expect(new Set(filenames).size).toBe(20);
    expect(pack).toContain('your own voice');
  });

  it('rejects ambiguous recording formats while finding the named human clip', () => {
    const directory = temporaryDirectory();
    expect(voicePath(directory, 'evergreen', 'crew-invite', directory)).toBeNull();
    writeFileSync(resolve(directory, 'crew-invite.wav'), 'recording');
    expect(voicePath(directory, 'evergreen', 'crew-invite', directory)).toBe(resolve(directory, 'crew-invite.wav'));
    writeFileSync(resolve(directory, 'crew-invite.m4a'), 'recording');
    expect(() => voicePath(directory, 'evergreen', 'crew-invite', directory)).toThrow('More than one recording');
  });

  it('permits a silent draft but refuses final audio without all clips and music', () => {
    const cut = buildTutorialCuts(EVERGREEN_EPISODE, new Map(), ['crew'])[0];
    expect(tutorialMixArgs(cut, null, 'draft.m4a', true)).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(() => tutorialMixArgs(cut, 'music.wav', 'final.m4a', false)).toThrow('recordings: crew-invite');
    const withVoices = {
      ...cut,
      beats: cut.beats.map((beat) => ({
        ...beat,
        voice: { path: `human ${beat.id}.wav`, seconds: 6, sha256: 'hash' },
      })),
    };
    expect(() => tutorialMixArgs(withVoices, null, 'final.m4a', false)).toThrow('supplied music');
    expect(tutorialMixArgs(withVoices, 'music $(literal).wav', 'final.m4a', false)).toContain('music $(literal).wav');
  });

  it('rejects unreadable native capture metadata before rendering', () => {
    const directory = temporaryDirectory();
    const takeDirectory = resolve(directory, 'work/android/takes/crew');
    mkdirSync(takeDirectory, { recursive: true });
    const writeManifest = (contents: unknown) =>
      writeFileSync(resolve(takeDirectory, 'manifest.json'), JSON.stringify(contents));
    writeManifest(manifest);
    expect(readTutorialTake(directory, 'android', 'crew')).toEqual(manifest);
    writeManifest({ ...manifest, nativeArtifactSha256: 'not-an-artifact-hash' });
    expect(() => readTutorialTake(directory, 'android', 'crew')).toThrow('Invalid capture metadata');
    writeManifest({ ...manifest, screen: {} });
    expect(() => readTutorialTake(directory, 'android', 'crew')).toThrow('Invalid capture metadata');
  });

  it('accepts normalized capture anchors with rounding tolerance and optional empty tracks', () => {
    const directory = temporaryDirectory();
    const takeDirectory = resolve(directory, 'work/android/takes/crew');
    mkdirSync(takeDirectory, { recursive: true });
    const contents = {
      ...manifest,
      seconds: manifest.seconds + 0.5 / 30,
      marks: { start: 0, end: manifest.seconds },
      anchors: {
        invitation: [{ t: 0, x: -0.00001, y: 0.8, width: 1.00002, height: 0.20001 }],
        unmeasuredOptional: [],
      },
    };
    writeFileSync(resolve(takeDirectory, 'manifest.json'), JSON.stringify(contents));
    expect(readTutorialTake(directory, 'android', 'crew')).toEqual(contents);
  });

  const invalidCaptureCases: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
    ['mark map is an array', { marks: [] }],
    ['mark is not finite', { marks: { invite: Number.POSITIVE_INFINITY } }],
    ['mark precedes capture', { marks: { invite: -0.01 } }],
    ['mark follows capture', { marks: { invite: 20.01 } }],
    ['duration contradicts frame count', { seconds: 21 }],
    ['anchor map is an array', { anchors: [] }],
    ['track is not an array', { anchors: { invite: { t: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.4 } } }],
    ['sample is null', { anchors: { invite: [null] } }],
    ['coordinates remain in dp', { anchors: { invite: [{ t: 2, x: 41, y: 92, width: 120, height: 160 }] } }],
    ['zero width', { anchors: { invite: [{ t: 2, x: 0.1, y: 0.2, width: 0, height: 0.4 }] } }],
    ['negative height', { anchors: { invite: [{ t: 2, x: 0.1, y: 0.2, width: 0.3, height: -0.4 }] } }],
    ['left edge outside screen', { anchors: { invite: [{ t: 2, x: -0.01, y: 0.2, width: 0.3, height: 0.4 }] } }],
    ['right edge outside screen', { anchors: { invite: [{ t: 2, x: 0.8, y: 0.2, width: 0.3, height: 0.4 }] } }],
    ['bottom edge outside screen', { anchors: { invite: [{ t: 2, x: 0.1, y: 0.8, width: 0.3, height: 0.4 }] } }],
    ['sample precedes capture', { anchors: { invite: [{ t: -0.01, x: 0.1, y: 0.2, width: 0.3, height: 0.4 }] } }],
    ['sample follows capture', { anchors: { invite: [{ t: 20.1, x: 0.1, y: 0.2, width: 0.3, height: 0.4 }] } }],
    ...['t', 'x', 'y', 'width', 'height'].map(
      (coordinate) =>
        [
          `nonfinite ${coordinate}`,
          { anchors: { invite: [{ t: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.4, [coordinate]: Number.NaN }] } },
        ] as const,
    ),
  ];
  it.each(invalidCaptureCases)('rejects malformed capture metadata: %s', (_reason, invalidFields) => {
    const directory = temporaryDirectory();
    const takeDirectory = resolve(directory, 'work/android/takes/crew');
    mkdirSync(takeDirectory, { recursive: true });
    writeFileSync(resolve(takeDirectory, 'manifest.json'), JSON.stringify({ ...manifest, ...invalidFields }));
    expect(() => readTutorialTake(directory, 'android', 'crew')).toThrow(/Invalid capture (metadata|mark|anchor)/);
  });

  it('rejects invalid authoring references rather than quietly omitting a beat', () => {
    const firstChapter = EVERGREEN_EPISODE.chapters[0];
    expect(() =>
      validateTutorialEpisode({
        ...EVERGREEN_EPISODE,
        chapters: [{ ...firstChapter, beats: [{ ...firstChapter.beats[0], takeId: 'missing' }] }],
      }),
    ).toThrow('missing take');
    expect(() =>
      validateTutorialEpisode({
        ...EVERGREEN_EPISODE,
        chapters: [
          { ...firstChapter, beats: [{ ...firstChapter.beats[0], focus: { x: 0.8, y: 0, width: 0.4, height: 0.5 } }] },
        ],
      }),
    ).toThrow('outside the screen');
  });
});

describe('instructional video CLI boundaries', () => {
  it('preserves explicit capture, audio and chapter options', () => {
    const argumentsList = [
      '--',
      '--episode',
      'evergreen',
      '--draft',
      '--record-only',
      '--only',
      'spray,crew',
      '--apk-path',
      '/tmp/dev client.apk',
      '--audio-dir',
      '/tmp/voice clips',
      '--music',
      '/tmp/music.wav',
      '--recapture',
    ];
    expect(parseTutorialArguments(argumentsList)).toMatchObject({
      episode: 'evergreen',
      platform: 'android',
      draft: true,
      recordOnly: true,
      only: ['spray', 'crew'],
      apkPath: '/tmp/dev client.apk',
      audioDir: '/tmp/voice clips',
      music: '/tmp/music.wav',
      recapture: true,
    });
  });

  it('rejects misspelled, repeated, missing and contradictory command options', () => {
    for (const argumentsList of [
      ['--drfat'],
      ['--platform', 'browser'],
      ['--episode'],
      ['--music', '--draft'],
      ['--draft', '--draft'],
      ['--episode', 'evergreen', '--episode', 'evergreen'],
      ['--record-only', '--render-only'],
      ['--only', 'crew,'],
    ]) {
      expect(() => parseTutorialArguments(argumentsList)).toThrow();
    }
  });
});
