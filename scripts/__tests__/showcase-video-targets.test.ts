import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SHOWCASE_OUT_DIR,
  SHOWCASE_TAKE_IDS,
  SHOWCASE_WEB_POSTER_DIR,
  SHOWCASE_WEB_VIDEO_DIR,
} from '../lib/showcase-video/contract';
import {
  PLACEHOLDER_SCREEN,
  SHOWCASE_CALLOUT_LAYOUT,
  SHOWCASE_PHONE,
  SHOWCASE_PLACEHOLDER_TAKES,
  SHOWCASE_POSES,
  SHOWCASE_STAGE_COPY,
  SHOWCASE_WEB_LITE,
  SHOWCASE_WEB_POSTER_FRAME,
  buildAppPreviewArgs,
  buildMasterArgs,
  countWords,
  layoutSceneCallouts,
  parseHeadline,
  parseRenderArgs,
  placeholderAnchorsFile,
  sceneCalloutCopy,
  type ShowcaseCopy,
} from '../lib/showcase-video/render';
import {
  APPLE_APP_PREVIEW_SPEC,
  SHOWCASE_DEFAULT_TARGETS,
  SHOWCASE_REEL_SAFE_AREA,
  SHOWCASE_SAFE_STAGE,
  SHOWCASE_TARGETS,
  SHOWCASE_TARGET_NAMES,
  appPreviewProblems,
  parseStreamProbe,
  resolveTargetNames,
  assertTargetLength,
  selectTargets,
  targetFrames,
  targetOutputs,
  targetSeconds,
  textOutsideSafeArea,
  type ProbedMedia,
  type ShowcaseTarget,
  type TextBox,
} from '../lib/showcase-video/targets';
import { SHOWCASE_FULL_PLAN, SHOWCASE_SCENES, resolveTimeline } from '../lib/showcase-video/timeline';

const copy = JSON.parse(readFileSync(SHOWCASE_STAGE_COPY, 'utf8')) as ShowcaseCopy;
const targets: ShowcaseTarget[] = SHOWCASE_TARGET_NAMES.map((name) => SHOWCASE_TARGETS[name]);
const publicDir = resolve(SHOWCASE_WEB_VIDEO_DIR, '../..');

describe('the target registry', () => {
  it('lists every target under its own name, with at least one rendition', () => {
    expect(Object.keys(SHOWCASE_TARGETS).sort()).toEqual([...SHOWCASE_TARGET_NAMES].sort());
    for (const target of targets) {
      expect(SHOWCASE_TARGETS[target.name]).toBe(target);
      expect(target.renditions.length, target.name).toBeGreaterThan(0);
      expect(target.summary.length, target.name).toBeGreaterThan(10);
      const ids = target.renditions.map((rendition) => rendition.id);
      expect(new Set(ids).size, target.name).toBe(ids.length);
      for (const { size } of target.renditions) {
        expect(size.width % 2, target.name).toBe(0);
        expect(size.height % 2, target.name).toBe(0);
      }
    }
  });

  it('gives motion targets storyboard scenes and full-bleed targets clips, never both', () => {
    const storyboard = new Set(SHOWCASE_SCENES.map((scene) => scene.id));
    for (const target of targets) {
      if (target.layout === 'motion') {
        expect(target.clips, target.name).toEqual([]);
        expect(target.scenes.length, target.name).toBeGreaterThan(0);
        for (const step of target.scenes) expect(storyboard.has(step.id), `${target.name}/${step.id}`).toBe(true);
        expect(new Set(target.scenes.map((step) => step.id)).size, target.name).toBe(target.scenes.length);
        // The loop: every motion cut opens on the boards trio (the poster, and where
        // the closer lands), goes straight to the spray wall, and closes on the outro.
        expect(target.scenes[0].id, target.name).toBe('boards');
        expect(target.scenes[1].id, target.name).toBe('spray');
        expect(target.scenes.at(-1)?.id, target.name).toBe('outro');
      } else {
        expect(target.scenes, target.name).toEqual([]);
        expect(target.clips.length, target.name).toBeGreaterThan(0);
        for (const clip of target.clips) expect(SHOWCASE_TAKE_IDS, clip.take).toContain(clip.take);
      }
    }
  });

  it('renders homepage + social by default, every target for all, and rejects an unknown name', () => {
    expect(resolveTargetNames([])).toEqual(['homepage', 'social']);
    expect(SHOWCASE_DEFAULT_TARGETS).toEqual(['homepage', 'social']);
    expect(resolveTargetNames(['all'])).toEqual([...SHOWCASE_TARGET_NAMES]);
    expect(resolveTargetNames(['reel', 'homepage'])).toEqual(['homepage', 'reel']);
    expect(() => resolveTargetNames(['tiktok'])).toThrow(/--target must be one of/);
    expect(parseRenderArgs(['--target', 'reel', '--target', 'app-store,play-promo']).targets).toEqual([
      'reel',
      'app-store',
      'play-promo',
    ]);
    expect(parseRenderArgs([]).targets).toEqual([]);
  });
});

describe('the homepage target', () => {
  it("is today's output exactly: the lite 9:16 hero, opening on frame 0, with the donation line", () => {
    expect(SHOWCASE_TARGETS.homepage).toEqual({
      name: 'homepage',
      summary: 'The homepage hero: lite 9:16 web encodes opening on the boards scene, and its poster',
      layout: 'motion',
      scenes: SHOWCASE_FULL_PLAN,
      clips: [],
      minSeconds: 0,
      maxSeconds: 60,
      donationLine: true,
      audio: { kind: 'none' },
      writesPublic: true,
      renditions: [
        {
          id: '9x16',
          format: '9x16',
          size: { width: 1080, height: 1920 },
          stage: {
            name: 'standard',
            headlineTop: 180,
            poses: SHOWCASE_POSES['9x16'],
            callouts: SHOWCASE_CALLOUT_LAYOUT,
          },
          safeArea: null,
          deliverable: {
            kind: 'web-lite',
            webm: `${SHOWCASE_WEB_VIDEO_DIR}/showcase-9x16-lite.webm`,
            mp4: `${SHOWCASE_WEB_VIDEO_DIR}/showcase-9x16-lite.mp4`,
            poster: `${SHOWCASE_WEB_POSTER_DIR}/showcase-hero-9x16.webp`,
            posterFrame: 0,
            size: { width: 720, height: 1280 },
            maxWebmBytes: 1_750_000,
            maxMp4Bytes: 1_900_000,
          },
        },
      ],
    });
    expect(SHOWCASE_WEB_POSTER_FRAME).toBe(0);
    expect(SHOWCASE_WEB_LITE).toEqual({
      size: { width: 720, height: 1280 },
      maxWebmBytes: 1_750_000,
      maxMp4Bytes: 1_900_000,
    });
    expect(SHOWCASE_FULL_PLAN.map((step) => step.id)).toEqual(SHOWCASE_SCENES.map((scene) => scene.id));
    expect(SHOWCASE_FULL_PLAN.every((step) => step.frames === undefined)).toBe(true);
    // The standard 9:16 stage is the one the homepage has always used.
    expect(SHOWCASE_POSES['9x16'].CALLOUT).toEqual({ cx: 540, cy: 1190, scale: 0.95, rx: 0, ry: 0, rz: 0 });
    expect(SHOWCASE_CALLOUT_LAYOUT.portraitPillInset).toBe(14);
  });

  it('keeps the social masters on the same cut: every scene, 16:9 and 9:16, in out/social/', () => {
    const social = SHOWCASE_TARGETS.social;
    expect(social.scenes).toBe(SHOWCASE_FULL_PLAN);
    expect(social.donationLine).toBe(true);
    expect(social.renditions.map((rendition) => rendition.id)).toEqual(['16x9', '9x16']);
    expect(targetOutputs(social)).toEqual([
      `${SHOWCASE_OUT_DIR}/social/brag.mp4`,
      `${SHOWCASE_OUT_DIR}/social/brag.jpg`,
      `${SHOWCASE_OUT_DIR}/social/share-copy.txt`,
      `${SHOWCASE_OUT_DIR}/social/brag-9x16.mp4`,
      `${SHOWCASE_OUT_DIR}/social/brag-9x16.jpg`,
    ]);
    // Same stage as the homepage, so the two 9:16 renditions share one render.
    expect(social.renditions[1].stage).toEqual(SHOWCASE_TARGETS.homepage.renditions[0].stage);
  });
});

describe('which targets a render covers', () => {
  const flags = { targets: [] as string[], formats: ['16x9', '9x16'] as const, skipWeb: false, donationLine: true };
  const names = (selection: ReturnType<typeof selectTargets>) => selection.picks.map(({ target }) => target.name);

  it('renders the default pair, every rendition', () => {
    const selection = selectTargets(flags);
    expect(names(selection)).toEqual(['homepage', 'social']);
    expect(selection.picks[1].renditions.map((rendition) => rendition.id)).toEqual(['16x9', '9x16']);
    expect(selection.notes).toEqual([]);
  });

  it('fails when a flag would drop a target the command names', () => {
    expect(() => selectTargets({ ...flags, targets: ['homepage'], skipWeb: true, donationLine: false })).toThrow(
      /--target homepage can't render with --no-donation-line/,
    );
    expect(() => selectTargets({ ...flags, targets: ['homepage'], skipWeb: true })).toThrow(/--skip-web/);
    expect(() => selectTargets({ ...flags, targets: ['reel'], formats: ['16x9'] })).toThrow(
      /--target reel has no 16x9 rendition \(it renders 9x16\)/,
    );
    expect(() => selectTargets({ ...flags, targets: ['play-promo'], formats: ['9x16'] })).toThrow(/play-promo/);
  });

  it('leaves out a default or all target with a note, not in silence', () => {
    const skipped = selectTargets({ ...flags, skipWeb: true, donationLine: false });
    expect(names(skipped)).toEqual(['social']);
    expect(skipped.notes).toEqual(['homepage left out (--no-donation-line: its files always carry the donation line)']);
    const portrait = selectTargets({ ...flags, targets: ['all'], formats: ['9x16'] });
    expect(names(portrait)).toEqual(['homepage', 'social', 'reel', 'app-store']);
    expect(portrait.notes).toEqual(['play-promo left out (--format 9x16; it renders 16x9)']);
  });
});

describe('durations', () => {
  it('holds motion and full-bleed cuts to the same window, both ends', () => {
    const reel = SHOWCASE_TARGETS.reel;
    expect(() => assertTargetLength(reel, 897)).not.toThrow();
    expect(() => assertTargetLength(reel, reel.maxSeconds * 30 + 1)).toThrow(/outside its 20–32 s window/);
    expect(() => assertTargetLength(reel, reel.minSeconds * 30 - 1)).toThrow(/outside/);
    expect(() => assertTargetLength(SHOWCASE_TARGETS['app-store'], 14 * 30)).toThrow(/15–30 s/);
  });

  it('keeps every target within its cap, with every take and without the island', () => {
    const all = new Set(SHOWCASE_TAKE_IDS);
    const noIsland = new Set(SHOWCASE_TAKE_IDS.filter((takeId) => takeId !== 'lock-screen'));
    for (const target of targets) {
      const seconds = targetSeconds(target);
      expect(seconds, target.name).toBeLessThanOrEqual(target.maxSeconds);
      expect(seconds, target.name).toBeGreaterThanOrEqual(target.minSeconds);
      expect(target.maxSeconds, target.name).toBeLessThanOrEqual(60);
      if (target.layout !== 'motion') continue;
      expect(resolveTimeline(all, target.scenes).totalFrames, target.name).toBe(targetFrames(target));
      expect(resolveTimeline(noIsland, target.scenes).totalFrames / 30, target.name).toBeLessThanOrEqual(
        target.maxSeconds,
      );
    }
  });

  it('lands each cut where it is going: reel about 30 s, play 30–45 s, the App Preview 15–30 s', () => {
    expect(targetSeconds(SHOWCASE_TARGETS.homepage)).toBeCloseTo(54.8);
    expect(targetSeconds(SHOWCASE_TARGETS.social)).toBeCloseTo(54.8);
    expect(targetSeconds(SHOWCASE_TARGETS.reel)).toBeCloseTo(29.9);
    expect(targetSeconds(SHOWCASE_TARGETS['play-promo'])).toBeCloseTo(38.1);
    const store = targetSeconds(SHOWCASE_TARGETS['app-store']);
    expect(store).toBeCloseTo(28);
    expect(store).toBeGreaterThanOrEqual(APPLE_APP_PREVIEW_SPEC.minSeconds);
    expect(store).toBeLessThanOrEqual(APPLE_APP_PREVIEW_SPEC.maxSeconds);
  });

  it('cuts the reel to boards, spray, crew, island and outro, and the play promo adds the log', () => {
    expect(SHOWCASE_TARGETS.reel.scenes).toEqual([
      { id: 'boards' },
      { id: 'spray' },
      { id: 'crew' },
      { id: 'lock-screen', frames: 150 },
      { id: 'outro', frames: 129 },
    ]);
    expect(SHOWCASE_TARGETS['play-promo'].scenes).toEqual([
      { id: 'boards' },
      { id: 'spray' },
      { id: 'crew' },
      { id: 'lock-screen' },
      { id: 'log' },
      { id: 'outro', frames: 129 },
    ]);
  });

  it('opens the App Preview on the spray wall, then wall, crew, island and log', () => {
    const { clips } = SHOWCASE_TARGETS['app-store'];
    expect(clips.map((clip) => [clip.take, clip.frames])).toEqual([
      ['spray', 135],
      ['wall', 165],
      ['crew', 225],
      ['lock-screen', 165],
      ['log', 150],
    ]);
    expect(clips[0]).toEqual({
      take: 'spray',
      caption: 'spray',
      captionTop: 14,
      segments: [{ mark: 'next-1', from: -2 }],
      frames: 135,
    });
    expect(copy.appStore.captions.spray).toBe('Your spray wall, too');
    expect(copy.appStore.captions).not.toHaveProperty('light');
  });
});

describe('where targets write', () => {
  it('lets only the homepage write into packages/web/public', () => {
    for (const target of targets) {
      const outputs = targetOutputs(target);
      expect(outputs.length, target.name).toBeGreaterThan(0);
      const inPublic = outputs.filter((path) => path.startsWith(publicDir));
      if (target.name === 'homepage') {
        expect(target.writesPublic).toBe(true);
        expect(inPublic).toEqual(outputs);
      } else {
        expect(target.writesPublic, target.name).toBe(false);
        expect(inPublic, target.name).toEqual([]);
        for (const path of outputs) expect(path.startsWith(`${SHOWCASE_OUT_DIR}/`), path).toBe(true);
      }
    }
  });

  it('gives each target its own folder under out/', () => {
    const folders = (name: ShowcaseTarget['name']) =>
      new Set(
        targetOutputs(SHOWCASE_TARGETS[name]).map((path) => path.slice(SHOWCASE_OUT_DIR.length + 1).split('/')[0]),
      );
    expect(folders('social')).toEqual(new Set(['social']));
    expect(folders('reel')).toEqual(new Set(['reel']));
    expect(folders('app-store')).toEqual(new Set(['app-store']));
    expect(folders('play-promo')).toEqual(new Set(['play']));
  });
});

describe('store and ad targets', () => {
  it('never carry the donation line', () => {
    for (const name of ['reel', 'app-store', 'play-promo'] as const) {
      expect(SHOWCASE_TARGETS[name].donationLine, name).toBe(false);
    }
    expect(SHOWCASE_TARGETS.homepage.donationLine).toBe(true);
    expect(SHOWCASE_TARGETS.social.donationLine).toBe(true);
    // The flag still overrides, and keeps the homepage (whose files carry the line) out.
    expect(parseRenderArgs(['--no-donation-line', '--target', 'social'])).toMatchObject({
      donationLine: false,
      skipWeb: true,
    });
  });

  it('give ad and store files a silent stereo track; the web and social files stay silent-free', () => {
    for (const name of ['reel', 'app-store', 'play-promo'] as const) {
      expect(SHOWCASE_TARGETS[name].audio, name).toEqual({ kind: 'silent-aac', kbps: 256, sampleRate: 48_000 });
    }
    expect(SHOWCASE_TARGETS.homepage.audio).toEqual({ kind: 'none' });
    expect(SHOWCASE_TARGETS.social.audio).toEqual({ kind: 'none' });
    const args = buildMasterArgs('/w/m.mkv', '/o/reel.mp4', SHOWCASE_TARGETS.reel.audio);
    expect(args.join(' ')).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    expect(args[args.indexOf('-ac') + 1]).toBe('2');
    expect(args).toContain('-shortest');
    expect(args).not.toContain('-an');
    expect(buildMasterArgs('/w/m.mkv', '/o/brag.mp4')).toContain('-an');
  });
});

describe('the app-store target', () => {
  const target = SHOWCASE_TARGETS['app-store'];
  const [rendition] = target.renditions;

  it('is full-bleed at Apple\'s iPhone 6.9" / 6.5" portrait size, written to both device slots', () => {
    expect(target.layout).toBe('full-bleed');
    expect(rendition.size).toEqual({ width: 886, height: 1920 });
    expect(APPLE_APP_PREVIEW_SPEC.iphonePortrait).toEqual({ width: 886, height: 1920 });
    expect(rendition.deliverable).toMatchObject({
      kind: 'app-preview',
      videos: [`${SHOWCASE_OUT_DIR}/app-store/iphone-6.9.mp4`, `${SHOWCASE_OUT_DIR}/app-store/iphone-6.5.mp4`],
    });
  });

  it('encodes H.264 High 4.0 at 30 fps, constant bitrate inside 10–12 Mbps, with a stereo AAC track', () => {
    const deliverable = rendition.deliverable;
    if (deliverable.kind !== 'app-preview') throw new Error('not an app preview');
    expect(deliverable.videoKbps).toBeGreaterThanOrEqual(APPLE_APP_PREVIEW_SPEC.videoKbps.min);
    expect(deliverable.videoKbps).toBeLessThanOrEqual(APPLE_APP_PREVIEW_SPEC.videoKbps.max);
    const args = buildAppPreviewArgs('/w/m.mkv', '/o/p.mp4', deliverable.videoKbps, target.audio);
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value('-c:v')).toBe('libx264');
    expect(value('-profile:v')).toBe('high');
    expect(value('-level:v')).toBe('4.0');
    expect(value('-r')).toBe('30');
    expect(value('-b:v')).toBe('11000k');
    expect(value('-minrate')).toBe('11000k');
    expect(value('-maxrate')).toBe('11000k');
    expect(value('-pix_fmt')).toBe('yuv420p');
    expect(value('-c:a')).toBe('aac');
    expect(value('-b:a')).toBe('256k');
    expect(value('-ac')).toBe('2');
    expect(value('-ar')).toBe('48000');
    expect(args.join(' ')).toContain('anullsrc=channel_layout=stereo');
  });

  it('keeps each caption to one line of five words or fewer, from the copy file', () => {
    for (const clip of target.clips) {
      const caption = copy.appStore.captions[clip.caption];
      expect(caption, clip.caption).toBeTruthy();
      expect(countWords(caption), caption).toBeLessThanOrEqual(5);
      expect(caption, caption).not.toMatch(/\n|\$|£|€|free|new|sale/i);
      expect(clip.captionTop, clip.caption).toBeGreaterThanOrEqual(0);
      expect(clip.captionTop + 128, clip.caption).toBeLessThanOrEqual(rendition.size.height);
    }
  });

  it('checks a probed encode against the spec and names every miss', () => {
    const good: ProbedMedia = {
      durationSeconds: 29,
      sizeBytes: 40_000_000,
      video: { codec: 'h264', profile: 'High', level: 40, width: 886, height: 1920, fps: 30, kbps: 11_020 },
      audio: { codec: 'aac', channels: 2, sampleRate: 48_000, kbps: 2 },
    };
    expect(appPreviewProblems(good, rendition.size)).toEqual([]);
    const bad: ProbedMedia = {
      durationSeconds: 31,
      sizeBytes: 40_000_000,
      video: { codec: 'h264', profile: 'Main', level: 41, width: 1080, height: 1920, fps: 60, kbps: 4_000 },
      audio: null,
    };
    const problems = appPreviewProblems(bad, rendition.size);
    expect(problems).toHaveLength(7);
    expect(problems.join('\n')).toMatch(/no audio track/);
    expect(appPreviewProblems({ ...good, audio: { ...good.audio!, channels: 1 } }, rendition.size)).toEqual([
      '1 audio channels, not stereo',
    ]);
  });

  it('reads ffprobe JSON into the numbers the check needs', () => {
    const media = parseStreamProbe(
      JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            profile: 'High',
            level: 40,
            width: 886,
            height: 1920,
            avg_frame_rate: '30/1',
            bit_rate: '11003000',
          },
          { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', bit_rate: '2000' },
        ],
        format: { duration: '29.000000', size: '39900000' },
      }),
    );
    expect(media).toEqual({
      durationSeconds: 29,
      sizeBytes: 39_900_000,
      video: { codec: 'h264', profile: 'High', level: 40, width: 886, height: 1920, fps: 30, kbps: 11_003 },
      audio: { codec: 'aac', channels: 2, sampleRate: 48_000, kbps: 2 },
    });
  });
});

describe('the reel safe area', () => {
  const reel = SHOWCASE_TARGETS.reel;
  const [rendition] = reel.renditions;
  const size = rendition.size;
  const area = SHOWCASE_REEL_SAFE_AREA;

  it("uses Meta's Reels ad margins at 1080x1920: 14% top, 35% bottom, 6% sides", () => {
    expect(size).toEqual({ width: 1080, height: 1920 });
    expect(rendition.safeArea).toEqual(area);
    expect(area.top).toBeGreaterThanOrEqual(Math.round(0.14 * 1920) - 1);
    expect(area.bottom).toBeGreaterThanOrEqual(Math.round(0.35 * 1920) - 1);
    expect(area.left).toBeGreaterThanOrEqual(Math.round(0.06 * 1080) - 1);
    expect(area.right).toBeGreaterThanOrEqual(Math.round(0.06 * 1080) - 1);
    expect(rendition.stage).toBe(SHOWCASE_SAFE_STAGE);
  });

  it('flags a text box that crosses a margin, and passes one inside', () => {
    const inside: TextBox = { label: 'in', x: 100, y: 400, width: 300, height: 80 };
    const high: TextBox = { label: 'high', x: 100, y: 200, width: 300, height: 80 };
    const low: TextBox = { label: 'low', x: 100, y: 1200, width: 300, height: 80 };
    const wide: TextBox = { label: 'wide', x: 20, y: 400, width: 300, height: 80 };
    expect(textOutsideSafeArea([inside, high, low, wide], size, area).map((box) => box.label)).toEqual([
      'high',
      'low',
      'wide',
    ]);
  });

  it('keeps every headline inside the band', () => {
    const band = { top: area.top, bottom: size.height - area.bottom };
    // 9:16 headlines: 88 px Inter Tight at 0.98 line height, the accent line 102 px.
    const lineHeight = 102;
    for (const step of reel.scenes) {
      const headline = step.id === 'outro' ? null : copy[step.id].headline;
      if (!headline) continue;
      const lines = parseHeadline(headline).length;
      const top = rendition.stage.headlineTop;
      expect(top, step.id).toBeGreaterThanOrEqual(band.top);
      expect(top + lines * lineHeight, step.id).toBeLessThanOrEqual(band.bottom);
      // Headlines start at 96 px and are 888 px wide: inside the side margins.
      expect(96).toBeGreaterThanOrEqual(area.left);
      expect(96 + 888).toBeLessThanOrEqual(size.width - area.right);
    }
  });

  it('keeps the callout phone inside the band, and every pill inside the safe area', () => {
    const { CALLOUT } = SHOWCASE_SAFE_STAGE.poses;
    const top = CALLOUT.cy - (SHOWCASE_PHONE.height / 2) * CALLOUT.scale;
    const bottom = CALLOUT.cy + (SHOWCASE_PHONE.height / 2) * CALLOUT.scale;
    expect(top).toBeGreaterThan(rendition.stage.headlineTop + 2 * 102);
    expect(bottom).toBeLessThanOrEqual(size.height - area.bottom);
    const pillHeight = SHOWCASE_SAFE_STAGE.callouts.portraitPillHeight;
    const band = { top: area.top + pillHeight / 2 + 6, bottom: size.height - area.bottom - pillHeight / 2 - 6 };
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
        sceneCalloutCopy(copy, scene.id),
        undefined,
        {
          poses: SHOWCASE_SAFE_STAGE.poses,
          layout: SHOWCASE_SAFE_STAGE.callouts,
          band,
        },
      );
      for (const callout of callouts) {
        const { portraitPillInset: inset, portraitPillWidth: width } = SHOWCASE_SAFE_STAGE.callouts;
        const x = callout.side === 'left' ? inset : size.width - inset - width;
        const pill: TextBox = { label: callout.name, x, y: callout.slotY - pillHeight / 2, width, height: pillHeight };
        expect(textOutsideSafeArea([pill], size, area), `${scene.id}/${callout.name}`).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it("keeps the boards scene's labels inside the band", () => {
    const { BOARDS_MID, BOARDS_LEFT, BOARDS_RIGHT } = SHOWCASE_SAFE_STAGE.poses;
    // Label top = phone top - gap (22) - 30; about 40 px tall. The two-row pile uses 900 / 1320 at 0.5 / 0.56.
    const labelTops = [
      ...[BOARDS_MID, BOARDS_LEFT, BOARDS_RIGHT].map((pose) => pose.cy - (SHOWCASE_PHONE.height / 2) * pose.scale - 52),
      900 - (SHOWCASE_PHONE.height / 2) * 0.5 - 52 - 12,
      1320 - (SHOWCASE_PHONE.height / 2) * 0.56 - 52 + 12,
    ];
    for (const top of labelTops) {
      expect(top).toBeGreaterThanOrEqual(area.top);
      expect(top + 40).toBeLessThanOrEqual(size.height - area.bottom);
    }
  });
});
