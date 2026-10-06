import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SHOWCASE_OUT_DIR,
  SHOWCASE_TAKE_IDS,
  SHOWCASE_WEB_POSTER_DIR,
  SHOWCASE_WEB_VIDEO_DIR,
  SHOWCASE_WORK_ROOT,
  type ShowcaseTakeId,
} from '../lib/showcase-video/contract';
import {
  ANDROID_SCREEN_PX,
  PLACEHOLDER_SCREEN,
  SHOWCASE_CANVAS,
  SHOWCASE_PHONE,
  SHOWCASE_PLACEHOLDER_TAKES,
  SHOWCASE_POSES,
  SHOWCASE_STAGE_COPY,
  SHOWCASE_TAKE_EDITS,
  SHOWCASE_TAKE_EDITS_BY_PLATFORM,
  anchorsFilePath,
  copyForPlatform,
  countWords,
  footageTakeDir,
  formatReadingBudgetTable,
  layoutSceneCallouts,
  marksFilePath,
  parseHeadline,
  parseRenderArgs,
  pixelPhone,
  placeholderAnchorsFile,
  readingBudgetMet,
  readingBudgetReport,
  renderWorkDirs,
  resolveTakeEdit,
  sceneCalloutCopy,
  screenToCanvas,
  showcasePhone,
  withoutDonationLine,
  type ResolvedTakeEdit,
  type ShowcaseCopy,
} from '../lib/showcase-video/render';
import {
  SHOWCASE_ANDROID_DEFAULT_TARGETS,
  SHOWCASE_ANDROID_TARGETS,
  SHOWCASE_ANDROID_TARGET_NAMES,
  SHOWCASE_REEL_SAFE_AREA,
  SHOWCASE_SAFE_STAGE,
  SHOWCASE_TARGETS,
  SHOWCASE_TARGET_NAMES,
  assertTargetLength,
  resolvePlatformTargets,
  resolveTargetNames,
  selectTargets,
  targetFrames,
  targetOutputs,
  targetSeconds,
  textOutsideSafeArea,
  type TextBox,
} from '../lib/showcase-video/targets';
import { SHOWCASE_SCENES, resolveTimeline, type ShowcaseScene } from '../lib/showcase-video/timeline';

const copy = JSON.parse(readFileSync(SHOWCASE_STAGE_COPY, 'utf8')) as ShowcaseCopy;
const androidTargets = SHOWCASE_ANDROID_TARGET_NAMES.map((name) => SHOWCASE_ANDROID_TARGETS[name]);
const work = resolve(SHOWCASE_WORK_ROOT, 'work');

describe('where a render reads its recording', () => {
  it('reads iOS from work/<kind>/ and Android from work/android/<kind>/', () => {
    const ios = renderWorkDirs('ios');
    const android = renderWorkDirs('android');
    expect(footageTakeDir('spray', ios)).toBe(`${work}/footage/spray`);
    expect(anchorsFilePath('spray', ios)).toBe(`${work}/anchors/spray.json`);
    expect(marksFilePath('spray', ios)).toBe(`${work}/marks/spray.json`);
    expect(footageTakeDir('lock-screen', android)).toBe(`${work}/android/footage/lock-screen`);
    expect(anchorsFilePath('lock-screen', android)).toBe(`${work}/android/anchors/lock-screen.json`);
    expect(marksFilePath('lock-screen', android)).toBe(`${work}/android/marks/lock-screen.json`);
  });

  it('keeps the iOS paths when no platform is named', () => {
    expect(footageTakeDir('crew')).toBe(`${work}/footage/crew`);
    expect(anchorsFilePath('crew')).toBe(`${work}/anchors/crew.json`);
    expect(marksFilePath('crew')).toBe(`${work}/marks/crew.json`);
  });

  it('reads a --work-dir instead, for either platform', () => {
    const scratch = renderWorkDirs('android', '/scratch/try');
    expect(footageTakeDir('spray', scratch)).toBe('/scratch/try/footage/spray');
    expect(anchorsFilePath('spray', scratch)).toBe('/scratch/try/anchors/spray.json');
    expect(marksFilePath('spray', scratch)).toBe('/scratch/try/marks/spray.json');
  });
});

describe('--platform and --work-dir', () => {
  it('defaults to the iOS recording in its own work dir', () => {
    expect(parseRenderArgs([])).toMatchObject({ platform: 'ios', workDir: null });
  });

  it('takes android, and a work dir', () => {
    expect(
      parseRenderArgs(['--platform', 'android', '--target', 'reel-android', '--work-dir', '/scratch/w']),
    ).toMatchObject({ platform: 'android', workDir: '/scratch/w', targets: ['reel-android'] });
  });

  it('refuses an unknown platform, and iOS placeholders on Android', () => {
    expect(() => parseRenderArgs(['--platform', 'windows-phone'])).toThrow(/--platform must be one of ios, android/);
    expect(() => parseRenderArgs(['--platform'])).toThrow(/needs a value/);
    expect(() => parseRenderArgs(['--platform', 'android', '--placeholder-footage'])).toThrow(/placeholder/);
    expect(parseRenderArgs(['--placeholder-footage']).placeholderFootage).toBe(true);
  });
});

describe('the Android target registry', () => {
  it('has an Android variant of every motion target, and none of the App Preview', () => {
    expect(SHOWCASE_ANDROID_TARGET_NAMES).toEqual([
      'homepage-android',
      'social-android',
      'reel-android',
      'play-promo-android',
    ]);
    expect(Object.keys(SHOWCASE_ANDROID_TARGETS).sort()).toEqual([...SHOWCASE_ANDROID_TARGET_NAMES].sort());
    expect(SHOWCASE_ANDROID_TARGET_NAMES).not.toContain('app-store-android');
    for (const target of androidTargets) {
      expect(target.platform, target.name).toBe('android');
      expect(target.layout, target.name).toBe('motion');
    }
    // The iOS registry is unchanged and carries no platform field.
    expect(SHOWCASE_TARGET_NAMES).toEqual(['homepage', 'social', 'reel', 'app-store', 'play-promo']);
    for (const name of SHOWCASE_TARGET_NAMES) expect(SHOWCASE_TARGETS[name].platform, name).toBeUndefined();
  });

  it('cuts the same scenes, stage, length, donation line and audio as the iOS target it follows', () => {
    const pairs = [
      ['homepage-android', 'homepage'],
      ['social-android', 'social'],
      ['reel-android', 'reel'],
      ['play-promo-android', 'play-promo'],
    ] as const;
    for (const [androidName, iosName] of pairs) {
      const android = SHOWCASE_ANDROID_TARGETS[androidName];
      const ios = SHOWCASE_TARGETS[iosName];
      expect(android.scenes, androidName).toBe(ios.scenes);
      expect(android.donationLine, androidName).toBe(ios.donationLine);
      expect(android.audio, androidName).toEqual(ios.audio);
      expect(android.writesPublic, androidName).toBe(ios.writesPublic);
      expect(targetSeconds(android), androidName).toBe(targetSeconds(ios));
      expect(
        android.renditions.map(({ id, format, size, stage, safeArea }) => ({ id, format, size, stage, safeArea })),
        androidName,
      ).toEqual(ios.renditions.map(({ id, format, size, stage, safeArea }) => ({ id, format, size, stage, safeArea })));
    }
  });

  it('writes the homepage cut beside the iOS hero, suffixed -android, and everything else under out/android/', () => {
    expect(targetOutputs(SHOWCASE_ANDROID_TARGETS['homepage-android'])).toEqual([
      `${SHOWCASE_WEB_VIDEO_DIR}/showcase-9x16-lite-android.webm`,
      `${SHOWCASE_WEB_VIDEO_DIR}/showcase-9x16-lite-android.mp4`,
      `${SHOWCASE_WEB_POSTER_DIR}/showcase-hero-9x16-android.webp`,
    ]);
    const [hero] = SHOWCASE_ANDROID_TARGETS['homepage-android'].renditions;
    expect(hero.deliverable).toMatchObject({
      kind: 'web-lite',
      posterFrame: 0,
      size: { width: 720, height: 1280 },
      maxWebmBytes: 1_750_000,
      maxMp4Bytes: 1_900_000,
    });
    expect(targetOutputs(SHOWCASE_ANDROID_TARGETS['social-android'])).toEqual([
      `${SHOWCASE_OUT_DIR}/android/social/brag.mp4`,
      `${SHOWCASE_OUT_DIR}/android/social/brag.jpg`,
      `${SHOWCASE_OUT_DIR}/android/social/share-copy.txt`,
      `${SHOWCASE_OUT_DIR}/android/social/brag-9x16.mp4`,
      `${SHOWCASE_OUT_DIR}/android/social/brag-9x16.jpg`,
    ]);
    expect(targetOutputs(SHOWCASE_ANDROID_TARGETS['reel-android'])).toEqual([
      `${SHOWCASE_OUT_DIR}/android/reel/reel-9x16.mp4`,
      `${SHOWCASE_OUT_DIR}/android/reel/reel-9x16.jpg`,
    ]);
    expect(targetOutputs(SHOWCASE_ANDROID_TARGETS['play-promo-android'])).toEqual([
      `${SHOWCASE_OUT_DIR}/android/play/play-16x9.mp4`,
      `${SHOWCASE_OUT_DIR}/android/play/play-16x9.jpg`,
    ]);
  });

  it('never writes over an iOS file, and only the homepage cut writes into packages/web/public', () => {
    const iosOutputs = new Set(SHOWCASE_TARGET_NAMES.flatMap((name) => targetOutputs(SHOWCASE_TARGETS[name])));
    const publicDir = resolve(SHOWCASE_WEB_VIDEO_DIR, '../..');
    for (const target of androidTargets) {
      for (const path of targetOutputs(target)) {
        expect(iosOutputs.has(path), path).toBe(false);
        expect(path.startsWith(publicDir), path).toBe(target.name === 'homepage-android');
      }
    }
  });

  it('picks targets from the --platform registry; all and the default never cross platforms', () => {
    const names = (values: string[], platform: 'ios' | 'android') =>
      resolvePlatformTargets(values, platform).map((target) => target.name);
    expect(names([], 'ios')).toEqual(['homepage', 'social']);
    expect(names(['all'], 'ios')).toEqual([...SHOWCASE_TARGET_NAMES]);
    expect(names([], 'android')).toEqual(['homepage-android', 'social-android']);
    expect(SHOWCASE_ANDROID_DEFAULT_TARGETS).toEqual(['homepage-android', 'social-android']);
    expect(names(['all'], 'android')).toEqual([...SHOWCASE_ANDROID_TARGET_NAMES]);
    expect(resolveTargetNames(['play-promo-android', 'reel-android'], 'android')).toEqual([
      'reel-android',
      'play-promo-android',
    ]);
    expect(() => names(['reel-android'], 'ios')).toThrow(/cuts the android recording: add --platform android/);
    expect(() => names(['reel'], 'android')).toThrow(/cuts the ios recording: add --platform ios/);
    expect(() => names(['app-store'], 'android')).toThrow(/--target must be one of homepage-android/);
    expect(() => names(['tiktok'], 'android')).toThrow(/--target must be one of/);
  });

  it('selects renditions and applies --skip-web within the Android registry', () => {
    const flags = {
      targets: [] as string[],
      formats: ['16x9', '9x16'] as const,
      skipWeb: false,
      donationLine: true,
      platform: 'android' as const,
    };
    const names = (selection: ReturnType<typeof selectTargets>) => selection.picks.map(({ target }) => target.name);
    expect(names(selectTargets(flags))).toEqual(['homepage-android', 'social-android']);
    const skipped = selectTargets({ ...flags, skipWeb: true });
    expect(names(skipped)).toEqual(['social-android']);
    expect(skipped.notes).toEqual(['homepage-android left out (--skip-web: leaves out the web files)']);
    expect(() => selectTargets({ ...flags, targets: ['homepage-android'], skipWeb: true })).toThrow(
      /--target homepage-android can't render with --skip-web/,
    );
    expect(() => selectTargets({ ...flags, targets: ['reel-android'], formats: ['16x9'] })).toThrow(
      /--target reel-android has no 16x9 rendition/,
    );
    expect(() => selectTargets({ ...flags, targets: ['reel-android'], platform: 'ios' })).toThrow(
      /add --platform android/,
    );
  });

  it('runs every Android target inside its length window', () => {
    for (const target of Object.values(SHOWCASE_ANDROID_TARGETS)) {
      expect(() => assertTargetLength(target, targetFrames(target)), target.name).not.toThrow();
    }
    const reel = SHOWCASE_ANDROID_TARGETS['reel-android'];
    expect(() => assertTargetLength(reel, reel.maxSeconds * 30 + 1)).toThrow(/reel-android runs/);
  });
});

describe('the Pixel mockup', () => {
  it('keeps the iPhone exactly as it was', () => {
    expect(showcasePhone('ios')).toBe(SHOWCASE_PHONE);
    expect(SHOWCASE_PHONE).toMatchObject({
      platform: 'ios',
      width: 428,
      height: 900,
      screenWidth: 402,
      screenHeight: 874,
      screenInset: 13,
      rim: 3,
      bodyRadius: 70,
      camera: { kind: 'island' },
    });
    // The stage's radii (70 body, 67 bezel, 57 screen) follow from the numbers.
    expect(SHOWCASE_PHONE.bodyRadius - SHOWCASE_PHONE.rim).toBe(67);
    expect(SHOWCASE_PHONE.bodyRadius - SHOWCASE_PHONE.screenInset).toBe(57);
  });

  it("draws a screen of the footage's aspect in the iPhone's height, so every pose holds", () => {
    const phone = pixelPhone();
    expect(phone.height).toBe(SHOWCASE_PHONE.height);
    expect(phone.screenHeight).toBe(phone.height - 2 * phone.screenInset);
    expect(phone.width).toBe(phone.screenWidth + 2 * phone.screenInset);
    const aspect = ANDROID_SCREEN_PX.width / ANDROID_SCREEN_PX.height;
    expect(Math.abs(phone.screenWidth / phone.screenHeight - aspect)).toBeLessThan(1 / phone.screenHeight);
    expect(phone).toMatchObject({ platform: 'android', screenWidth: 390, screenHeight: 876, width: 414 });
    // The footage's own frames (800 wide at 1080x2424) land on the same screen.
    expect(pixelPhone(800 / 1796).screenWidth).toBe(390);
    expect(showcasePhone('android', 800 / 1796)).toEqual(pixelPhone(800 / 1796));
    expect(() => pixelPhone(16 / 9)).toThrow(/not a portrait phone/);
  });

  it('has squarer corners, a centred punch-hole, and buttons on the right edge only', () => {
    const phone = pixelPhone();
    const screenRadius = (candidate: typeof phone) => candidate.bodyRadius - candidate.screenInset;
    expect(screenRadius(phone) / phone.screenWidth).toBeLessThan(
      screenRadius(SHOWCASE_PHONE) / SHOWCASE_PHONE.screenWidth,
    );
    expect(phone.camera).toEqual({ kind: 'punch-hole', diameter: 12, top: 14 });
    expect(phone.buttons.map((button) => button.side)).toEqual(['right', 'right']);
    // Power above the volume rocker, both on the phone's side.
    const [power, volume] = phone.buttons;
    expect(power.top + power.height).toBeLessThan(volume.top);
    expect(volume.height).toBeGreaterThan(power.height);
    expect(volume.top + volume.height).toBeLessThan(phone.height);
  });

  it("maps the whole recorded screen onto the Pixel's screen box", () => {
    const phone = pixelPhone();
    const canvas = SHOWCASE_CANVAS['16x9'];
    const flat = SHOWCASE_POSES['16x9'].CALLOUT;
    const box = screenToCanvas(
      { x: 0, y: 0, width: 412, height: 923 },
      { width: 412, height: 923 },
      flat,
      canvas,
      phone,
    );
    expect(box.width).toBeCloseTo(390, 6);
    expect(box.height).toBeCloseTo(876, 6);
    expect(box.x).toBeCloseTo(flat.cx - 195, 6);
    expect(box.y).toBeCloseTo(flat.cy - 438, 6);
  });
});

describe('Android copy', () => {
  const android = copyForPlatform(copy, 'android');
  const ios = copyForPlatform(copy, 'ios');

  it('leaves the iOS copy as it was, without the override block', () => {
    const { android: _block, ...shared } = copy;
    expect(ios).toEqual(shared);
    expect('android' in ios).toBe(false);
    expect('android' in android).toBe(false);
  });

  it('names the notification instead of the island, in five words or fewer', () => {
    const scene = android['lock-screen'];
    expect(scene.headline).not.toBe(copy['lock-screen'].headline);
    expect(scene.headline).not.toMatch(/island/i);
    expect(countWords(scene.headline.replace(/\*/g, ''))).toBeLessThanOrEqual(5);
    // The accent word is one italic word, like every other headline.
    expect(
      parseHeadline(scene.headline)
        .flat()
        .filter((word) => word.accent),
    ).toHaveLength(1);
    // The notification's own button labels (session.json "notification").
    expect(scene.callouts).toEqual({
      'lock-next': 'Next',
      'lock-relight': 'Relight wall',
      'lock-mirror': 'Mirror climb',
    });
  });

  it('shares every other scene with iOS', () => {
    for (const key of Object.keys(ios) as (keyof ShowcaseCopy)[]) {
      if (key === 'lock-screen') continue;
      expect(android[key], key).toEqual(ios[key]);
    }
  });
});

/**
 * The first Android recording's marks and frame counts (work/android/marks,
 * footage). It predates the spray take, so the spray scene is budgeted here
 * without an edit; add its marks after the first Android spray recording.
 */
const ANDROID_MARKS: Partial<Record<ShowcaseTakeId, Record<string, number>>> = {
  wall: { 'sheet-open': 4.122, 'history-shown': 8.228 },
  crew: { 'invite-closed': 4.167, 'queue-open': 12.292, 'row-landed': 14.819, 'crew-added': 15.886 },
  workouts: { 'pyramid-picked': 2.996, 'rest-armed': 6.669, 'rest-pill': 10.782, started: 17.187 },
  'lock-screen': { home: 2.678, 'island-expanded': 6.096, 'next-tapped': 10.174 },
  log: { scrolled: 4.523, 'filter-kilter': 9.007, 'filter-tension': 15.186 },
};
const ANDROID_FRAMES: Partial<Record<ShowcaseTakeId, number>> = {
  wall: 409,
  crew: 618,
  workouts: 702,
  'lock-screen': 481,
  log: 602,
};

describe('Android cuts', () => {
  const edits = (scenes: readonly ShowcaseScene[]) => {
    const resolved: Partial<Record<ShowcaseTakeId, ResolvedTakeEdit>> = {};
    for (const scene of scenes) {
      for (const takeId of scene.takes) {
        const edit = SHOWCASE_TAKE_EDITS_BY_PLATFORM.android[takeId];
        const marks = ANDROID_MARKS[takeId];
        const frames = ANDROID_FRAMES[takeId];
        if (!edit || !marks || !frames) continue;
        resolved[takeId] = resolveTakeEdit(takeId, edit, marks, scene.endFrame - scene.startFrame, frames);
      }
    }
    return resolved;
  };

  it('gives every recorded Android take an explicit cut, never an empty one', () => {
    for (const takeId of Object.keys(ANDROID_MARKS) as ShowcaseTakeId[]) {
      const edit = SHOWCASE_TAKE_EDITS_BY_PLATFORM.android[takeId];
      expect(edit?.segments.length ?? 0, takeId).toBeGreaterThan(0);
    }
    // Written out, not read from the iOS entry, so an iOS change can't empty it.
    expect(SHOWCASE_TAKE_EDITS_BY_PLATFORM.android.log?.segments).not.toBe(SHOWCASE_TAKE_EDITS.log?.segments);
    expect(SHOWCASE_TAKE_EDITS_BY_PLATFORM.android.log?.segments.map((span) => span.mark)).toEqual([
      'scrolled',
      'filter-kilter',
    ]);
  });

  it('cuts the island take on the iOS marks, and Android footage on its own edit', () => {
    expect(SHOWCASE_TAKE_EDITS_BY_PLATFORM.ios).toBe(SHOWCASE_TAKE_EDITS);
    expect(SHOWCASE_TAKE_EDITS_BY_PLATFORM.android.wall).not.toBe(SHOWCASE_TAKE_EDITS.wall);
    // No "Play next" on Android (the queue sheet takes an injected long press as a tap).
    expect(SHOWCASE_TAKE_EDITS_BY_PLATFORM.android.crew?.callouts?.['play-next']).toBeUndefined();
    expect(SHOWCASE_TAKE_EDITS_BY_PLATFORM.android['lock-screen']?.segments.map((span) => span.mark)).toEqual([
      'island-expanded',
      'next-tapped',
    ]);
  });

  it('meets the reading budget in every Android target with the Android copy', () => {
    const available = new Set(SHOWCASE_TAKE_IDS);
    const androidCopy = copyForPlatform(copy, 'android');
    for (const target of androidTargets) {
      const timeline = resolveTimeline(available, target.scenes);
      const targetCopy = target.donationLine ? androidCopy : withoutDonationLine(androidCopy);
      for (const report of readingBudgetReport(targetCopy, timeline.scenes, edits(timeline.scenes))) {
        expect(
          readingBudgetMet(report),
          `${target.name}/${report.sceneId}\n${formatReadingBudgetTable([report])}`,
        ).toBe(true);
      }
    }
  });

  it("keeps the reel's pills inside Meta's safe area around the Pixel", () => {
    const reel = SHOWCASE_ANDROID_TARGETS['reel-android'];
    const [rendition] = reel.renditions;
    const area = SHOWCASE_REEL_SAFE_AREA;
    const pillHeight = SHOWCASE_SAFE_STAGE.callouts.portraitPillHeight;
    const band = { top: area.top + pillHeight / 2 + 6, bottom: 1920 - area.bottom - pillHeight / 2 - 6 };
    const androidCopy = copyForPlatform(copy, 'android');
    const timeline = resolveTimeline(new Set(SHOWCASE_TAKE_IDS), reel.scenes);
    let checked = 0;
    for (const scene of timeline.scenes) {
      if (scene.callouts.length === 0) continue;
      const file = placeholderAnchorsFile(scene.takes[0], SHOWCASE_PLACEHOLDER_TAKES[scene.takes[0]]);
      expect(file.screen).toEqual(PLACEHOLDER_SCREEN);
      const callouts = layoutSceneCallouts(
        '9x16',
        scene,
        scene.callouts,
        file,
        sceneCalloutCopy(androidCopy, scene.id),
        undefined,
        { poses: SHOWCASE_SAFE_STAGE.poses, layout: SHOWCASE_SAFE_STAGE.callouts, band, phone: pixelPhone() },
      );
      for (const callout of callouts) {
        const { portraitPillInset: inset, portraitPillWidth: width } = SHOWCASE_SAFE_STAGE.callouts;
        const x = callout.side === 'left' ? inset : rendition.size.width - inset - width;
        const pill: TextBox = { label: callout.name, x, y: callout.slotY - pillHeight / 2, width, height: pillHeight };
        expect(textOutsideSafeArea([pill], rendition.size, area), `${scene.id}/${callout.name}`).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
    expect(SHOWCASE_SCENES.find((scene) => scene.id === 'lock-screen')?.callouts).toHaveLength(3);
  });
});
