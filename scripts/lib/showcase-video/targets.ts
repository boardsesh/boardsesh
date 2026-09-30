import { resolve } from 'node:path';
import {
  SHOWCASE_FPS,
  SHOWCASE_OUT_DIR,
  SHOWCASE_WEB_POSTER_DIR,
  SHOWCASE_WEB_VIDEO_DIR,
  type ShowcaseTakeId,
} from './contract';
import {
  SHOWCASE_CALLOUT_LAYOUT,
  SHOWCASE_POSES,
  SHOWCASE_WEB_LITE,
  SHOWCASE_WEB_POSTER_FRAME,
  type CalloutLayout,
  type MarkSpan,
  type ShowcaseFormat,
  type ShowcasePose,
  type ShowcasePoseName,
} from './render';
import { SHOWCASE_FULL_PLAN, planFrames, type ShowcaseScenePlan } from './timeline';

/**
 * Render targets: several cuts of the same recorded takes, one per place the
 * video goes. `vp run video:render -- --target <name>` renders one, `--target
 * all` every one, and no `--target` renders `homepage` and `social` (what
 * `vp run video` ships). docs/showcase-video.md ("Targets") has the table.
 */
export const SHOWCASE_TARGET_NAMES = ['homepage', 'social', 'reel', 'app-store', 'play-promo'] as const;
export type ShowcaseTargetName = (typeof SHOWCASE_TARGET_NAMES)[number];

/** What `vp run video:render` renders without `--target`. */
export const SHOWCASE_DEFAULT_TARGETS: readonly ShowcaseTargetName[] = ['homepage', 'social'];

/**
 * `motion`: the phone-mockup motion design (the stage in index.html).
 * `full-bleed`: the recorded app footage filling the frame with one-line
 * caption bars, no phone, callouts or motion-graphic scenes (full-bleed.html).
 */
export type ShowcaseLayoutStyle = 'motion' | 'full-bleed';

/**
 * `none`: video only. `silent-aac`: a silent stereo AAC track, for platforms
 * that refuse a file without audio (Apple App Previews, ad managers).
 */
export type ShowcaseAudio =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'silent-aac'; kbps: number; sampleRate: number }>;

/** Pixels from each edge of the frame that must stay free of text. */
export type ShowcaseSafeArea = Readonly<{ top: number; bottom: number; left: number; right: number }>;

/**
 * Stage variants for the motion layout. `standard` is the homepage / social
 * stage. `safe` moves the headline down, shrinks and lifts the phone and pulls
 * the pills in, so every word sits inside a safe area.
 */
export type ShowcaseStageVariant = Readonly<{
  name: 'standard' | 'safe';
  /** 9:16 headline top (px); the checklist follows it. */
  headlineTop: number;
  poses: Record<ShowcasePoseName, ShowcasePose>;
  callouts: CalloutLayout;
}>;

/** What a rendition writes. */
export type ShowcaseDeliverable =
  | Readonly<{
      /** The homepage hero: lite VP9 + H.264 encodes rotated to open on the poster frame, and that frame as WebP. */
      kind: 'web-lite';
      webm: string;
      mp4: string;
      poster: string;
      posterFrame: number;
      size: Readonly<{ width: number; height: number }>;
      maxWebmBytes: number;
      maxMp4Bytes: number;
    }>
  | Readonly<{
      /** A crf 18 H.264 master and its frame-0 still (`share` also gets the share copy). */
      kind: 'master';
      video: string;
      still: string;
      shareCopy: string | null;
    }>
  | Readonly<{
      /**
       * Apple App Preview: H.264 High, CBR in Apple's 10–12 Mbps window, 30 fps,
       * stereo AAC. One encode, copied to each device slot that takes the same
       * resolution.
       */
      kind: 'app-preview';
      videos: readonly string[];
      still: string;
      videoKbps: number;
    }>;

export type ShowcaseRendition = Readonly<{
  /** Names the rendition in logs and stills (`16x9`, `9x16`, `iphone`). */
  id: string;
  /** Stage family for the motion layout (canvas CSS, poses); the full-bleed layout ignores it. */
  format: ShowcaseFormat;
  size: Readonly<{ width: number; height: number }>;
  stage: ShowcaseStageVariant;
  safeArea: ShowcaseSafeArea | null;
  deliverable: ShowcaseDeliverable;
}>;

/** One stretch of full-bleed footage: a take cut on its marks, under one caption. */
export type ShowcaseClip = Readonly<{
  take: ShowcaseTakeId;
  /** Key under `appStore.captions` in copy.en-US.json: one line, five words at most. */
  caption: string;
  /** Top of the caption bar, px at the rendition size; chosen per take so it covers nothing the clip shows. */
  captionTop: number;
  /** Mark-relative footage, as in `SHOWCASE_TAKE_EDITS`; the last span fills the clip. */
  segments: readonly MarkSpan[];
  frames: number;
}>;

export type ShowcaseTarget = Readonly<{
  name: ShowcaseTargetName;
  summary: string;
  layout: ShowcaseLayoutStyle;
  /** Motion layout: the storyboard scenes, in order, with any length changes. */
  scenes: readonly ShowcaseScenePlan[];
  /** Full-bleed layout: the clips, in order. */
  clips: readonly ShowcaseClip[];
  minSeconds: number;
  maxSeconds: number;
  /** The outro's "Paid for by the climbers who use it." Store and ad cuts must not mention donations. */
  donationLine: boolean;
  audio: ShowcaseAudio;
  /** Only `homepage` may write into packages/web/public. */
  writesPublic: boolean;
  renditions: readonly ShowcaseRendition[];
}>;

// --- stage variants --------------------------------------------------------------------

export const SHOWCASE_STANDARD_STAGE: ShowcaseStageVariant = {
  name: 'standard',
  headlineTop: 180,
  poses: SHOWCASE_POSES['9x16'],
  callouts: SHOWCASE_CALLOUT_LAYOUT,
};

const standardStage = (format: ShowcaseFormat): ShowcaseStageVariant => ({
  ...SHOWCASE_STANDARD_STAGE,
  poses: SHOWCASE_POSES[format],
});

/**
 * Meta's text-free margins for Reels and Stories ads at 1080x1920: 14% top,
 * 35% bottom (the caption, CTA and like rail), 6% each side. Checked
 * 2026-10-01 at https://www.facebook.com/business/ads-guide/update/image/instagram-reels
 * and https://www.facebook.com/business/help/980593475366490. Organic Reels
 * cover less of the bottom; the ad margins cover both.
 */
export const SHOWCASE_REEL_SAFE_AREA: ShowcaseSafeArea = { top: 270, bottom: 672, left: 65, right: 65 };

const pose = (cx: number, cy: number, scale: number): ShowcasePose => ({ cx, cy, scale, rx: 0, ry: 0, rz: 0 });

/**
 * The 9:16 stage inside `SHOWCASE_REEL_SAFE_AREA`: headlines from 300 px, the
 * callout phone small enough (0.76) that a 336 px pill fits beside it inside
 * the side margins and whole inside the text band (520–1204 px), so every
 * pill, which sits level with its anchor, lands in the band too. The island
 * zoom starts below a three-line headline.
 */
export const SHOWCASE_SAFE_STAGE: ShowcaseStageVariant = {
  name: 'safe',
  headlineTop: 300,
  poses: {
    ...SHOWCASE_POSES['9x16'],
    CALLOUT: pose(540, 862, 0.76),
    ISLAND: pose(540, 1300, 1.4),
  },
  callouts: { ...SHOWCASE_CALLOUT_LAYOUT, portraitPillInset: 72 },
};

// --- targets -----------------------------------------------------------------------------

const out = (...parts: string[]) => resolve(SHOWCASE_OUT_DIR, ...parts);

/** Apple's App Preview numbers this target was built to; docs/showcase-video.md has the source and date. */
export const APPLE_APP_PREVIEW_SPEC = {
  /** iPhone 6.9" and 6.5" (and 6.7", 6.3", 6.1") portrait. */
  iphonePortrait: { width: 886, height: 1920 },
  minSeconds: 15,
  maxSeconds: 30,
  maxFps: 30,
  videoKbps: { min: 10_000, max: 12_000 },
  h264: { profile: 'high', level: '4.0' },
  audio: { channels: 2, codec: 'aac', kbps: 256, sampleRates: [44_100, 48_000] },
  maxBytes: 500_000_000,
} as const;

const SILENT_AAC: ShowcaseAudio = { kind: 'silent-aac', kbps: 256, sampleRate: 48_000 };

/** No donation line: the outro's reading budget needs 129 frames, not 192. */
const SHORT_OUTRO: ShowcaseScenePlan = { id: 'outro', frames: 129 };

export const SHOWCASE_TARGETS: Record<ShowcaseTargetName, ShowcaseTarget> = {
  homepage: {
    name: 'homepage',
    summary: 'The homepage hero: lite 9:16 web encodes opening on the light scene, and its poster',
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
        stage: standardStage('9x16'),
        safeArea: null,
        deliverable: {
          kind: 'web-lite',
          webm: resolve(SHOWCASE_WEB_VIDEO_DIR, 'showcase-9x16-lite.webm'),
          mp4: resolve(SHOWCASE_WEB_VIDEO_DIR, 'showcase-9x16-lite.mp4'),
          poster: resolve(SHOWCASE_WEB_POSTER_DIR, 'showcase-hero-9x16.webp'),
          posterFrame: SHOWCASE_WEB_POSTER_FRAME,
          size: SHOWCASE_WEB_LITE.size,
          maxWebmBytes: SHOWCASE_WEB_LITE.maxWebmBytes,
          maxMp4Bytes: SHOWCASE_WEB_LITE.maxMp4Bytes,
        },
      },
    ],
  },
  social: {
    name: 'social',
    summary: 'Full-quality 16:9 and 9:16 masters for social posts, frame 0 the hook',
    layout: 'motion',
    scenes: SHOWCASE_FULL_PLAN,
    clips: [],
    minSeconds: 0,
    maxSeconds: 60,
    donationLine: true,
    audio: { kind: 'none' },
    writesPublic: false,
    renditions: [
      {
        id: '16x9',
        format: '16x9',
        size: { width: 1920, height: 1080 },
        stage: standardStage('16x9'),
        safeArea: null,
        deliverable: {
          kind: 'master',
          video: out('social', 'brag.mp4'),
          still: out('social', 'brag.jpg'),
          shareCopy: out('social', 'share-copy.txt'),
        },
      },
      {
        id: '9x16',
        format: '9x16',
        size: { width: 1080, height: 1920 },
        stage: standardStage('9x16'),
        safeArea: null,
        deliverable: {
          kind: 'master',
          video: out('social', 'brag-9x16.mp4'),
          still: out('social', 'brag-9x16.jpg'),
          shareCopy: null,
        },
      },
    ],
  },
  reel: {
    name: 'reel',
    summary: "About 30 s of 9:16 for Instagram Reels and app-install ads, text inside Meta's safe zone",
    layout: 'motion',
    scenes: [
      { id: 'hook' },
      { id: 'light', frames: 150 },
      { id: 'boards', frames: 138 },
      { id: 'crew' },
      { id: 'lock-screen', frames: 150 },
      SHORT_OUTRO,
    ],
    clips: [],
    minSeconds: 20,
    maxSeconds: 32,
    donationLine: false,
    audio: SILENT_AAC,
    writesPublic: false,
    renditions: [
      {
        id: '9x16',
        format: '9x16',
        size: { width: 1080, height: 1920 },
        stage: SHOWCASE_SAFE_STAGE,
        safeArea: SHOWCASE_REEL_SAFE_AREA,
        deliverable: {
          kind: 'master',
          video: out('reel', 'reel-9x16.mp4'),
          still: out('reel', 'reel-9x16.jpg'),
          shareCopy: null,
        },
      },
    ],
  },
  'app-store': {
    name: 'app-store',
    summary: 'Apple App Preview: the app footage full-bleed at 886x1920 with one-line captions',
    layout: 'full-bleed',
    scenes: [],
    // Caption bars sit over the status bar, except on the island clip, whose
    // top is the Dynamic Island: there it sits over the empty wallpaper.
    clips: [
      // Ends on the first swipe's climb, before the second swipe starts.
      { take: 'light', caption: 'light', captionTop: 22, segments: [{ mark: 'bulb-tapped', from: -0.3 }], frames: 150 },
      {
        take: 'wall',
        caption: 'wall',
        captionTop: 22,
        segments: [
          { mark: 'sheet-open', from: -3.4, to: 0.5 },
          { mark: 'history-shown', from: -0.5 },
        ],
        frames: 165,
      },
      {
        take: 'crew',
        caption: 'crew',
        captionTop: 22,
        segments: [
          { mark: 'invite-closed', from: -4.5, to: -2.3 },
          { mark: 'row-landed', from: -0.6, to: 2.0 },
          { mark: 'play-next-menu', from: -2.6 },
        ],
        frames: 225,
      },
      {
        take: 'lock-screen',
        caption: 'lock-screen',
        captionTop: 1120,
        segments: [{ mark: 'island-expanded', from: -0.5 }],
        frames: 165,
      },
      {
        take: 'log',
        caption: 'log',
        captionTop: 22,
        segments: [
          { mark: 'scrolled', from: -1.0, to: 0.6 },
          { mark: 'filter-kilter', from: -2.2 },
        ],
        frames: 150,
      },
    ],
    minSeconds: APPLE_APP_PREVIEW_SPEC.minSeconds,
    maxSeconds: APPLE_APP_PREVIEW_SPEC.maxSeconds,
    donationLine: false,
    audio: SILENT_AAC,
    writesPublic: false,
    renditions: [
      {
        id: 'iphone',
        format: '9x16',
        size: APPLE_APP_PREVIEW_SPEC.iphonePortrait,
        stage: SHOWCASE_STANDARD_STAGE,
        safeArea: null,
        deliverable: {
          kind: 'app-preview',
          // Both device classes take 886x1920 portrait: one encode, two slots.
          videos: [out('app-store', 'iphone-6.9.mp4'), out('app-store', 'iphone-6.5.mp4')],
          still: out('app-store', 'iphone-poster.jpg'),
          videoKbps: 11_000,
        },
      },
    ],
  },
  'play-promo': {
    name: 'play-promo',
    summary: 'A 16:9 cut for the YouTube video Google Play links to',
    layout: 'motion',
    scenes: [
      { id: 'hook' },
      { id: 'light' },
      { id: 'boards' },
      { id: 'crew' },
      { id: 'lock-screen' },
      { id: 'log' },
      SHORT_OUTRO,
    ],
    clips: [],
    minSeconds: 30,
    maxSeconds: 45,
    donationLine: false,
    audio: SILENT_AAC,
    writesPublic: false,
    renditions: [
      {
        id: '16x9',
        format: '16x9',
        size: { width: 1920, height: 1080 },
        stage: standardStage('16x9'),
        safeArea: null,
        deliverable: {
          kind: 'master',
          video: out('play', 'play-16x9.mp4'),
          still: out('play', 'play-16x9.jpg'),
          shareCopy: null,
        },
      },
    ],
  },
};

/** Frames a target runs with every take present. */
export function targetFrames(target: ShowcaseTarget): number {
  return target.layout === 'full-bleed'
    ? target.clips.reduce((sum, clip) => sum + clip.frames, 0)
    : planFrames(target.scenes);
}

export const targetSeconds = (target: ShowcaseTarget): number => targetFrames(target) / SHOWCASE_FPS;

/** Every file a target writes. */
export function targetOutputs(target: ShowcaseTarget): string[] {
  return target.renditions.flatMap(({ deliverable }) => {
    if (deliverable.kind === 'web-lite') return [deliverable.webm, deliverable.mp4, deliverable.poster];
    if (deliverable.kind === 'master')
      return [deliverable.video, deliverable.still, ...(deliverable.shareCopy ? [deliverable.shareCopy] : [])];
    return [...deliverable.videos, deliverable.still];
  });
}

/**
 * `--target` values → targets, in registry order. `all` is every target; no
 * value is `SHOWCASE_DEFAULT_TARGETS`.
 */
export function resolveTargetNames(values: readonly string[]): ShowcaseTargetName[] {
  if (values.length === 0) return [...SHOWCASE_DEFAULT_TARGETS];
  if (values.includes('all')) return [...SHOWCASE_TARGET_NAMES];
  for (const value of values) {
    if (!(SHOWCASE_TARGET_NAMES as readonly string[]).includes(value)) {
      throw new Error(`--target must be one of ${SHOWCASE_TARGET_NAMES.join(', ')}, or all`);
    }
  }
  return SHOWCASE_TARGET_NAMES.filter((name) => values.includes(name));
}

// --- checks ---------------------------------------------------------------------------------

/** A piece of text on a rendered frame, in canvas px (the stage's `textBoxes()`). */
export type TextBox = Readonly<{ label: string; x: number; y: number; width: number; height: number }>;

/** Text boxes that cross into a safe area's margins (1 px of slack for subpixel edges). */
export function textOutsideSafeArea(
  boxes: readonly TextBox[],
  size: Readonly<{ width: number; height: number }>,
  area: ShowcaseSafeArea,
): TextBox[] {
  const slack = 1;
  return boxes.filter(
    (box) =>
      box.x < area.left - slack ||
      box.y < area.top - slack ||
      box.x + box.width > size.width - area.right + slack ||
      box.y + box.height > size.height - area.bottom + slack,
  );
}

/** What ffprobe says about an encode, reduced to what the store checks need. */
export type ProbedMedia = Readonly<{
  durationSeconds: number;
  sizeBytes: number;
  video: Readonly<{
    codec: string;
    profile: string;
    level: number;
    width: number;
    height: number;
    fps: number;
    kbps: number;
  }> | null;
  audio: Readonly<{ codec: string; channels: number; sampleRate: number; kbps: number }> | null;
}>;

type ProbeJson = Readonly<{
  streams?: ReadonlyArray<Readonly<Record<string, string | number | undefined>>>;
  format?: Readonly<Record<string, string | number | undefined>>;
}>;

const numeric = (value: string | number | undefined): number => (value === undefined ? 0 : Number(value));

/** `ffprobe -of json` (render.ts `buildStreamProbeArgs`) → `ProbedMedia`. */
export function parseStreamProbe(json: string): ProbedMedia {
  const parsed = JSON.parse(json) as ProbeJson;
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const rate = String(video?.avg_frame_rate ?? '0/1').split('/');
  return {
    durationSeconds: numeric(parsed.format?.duration),
    sizeBytes: numeric(parsed.format?.size),
    video: video
      ? {
          codec: String(video.codec_name),
          profile: String(video.profile),
          level: numeric(video.level),
          width: numeric(video.width),
          height: numeric(video.height),
          fps: numeric(rate[0]) / (numeric(rate[1]) || 1),
          kbps: numeric(video.bit_rate) / 1000,
        }
      : null,
    audio: audio
      ? {
          codec: String(audio.codec_name),
          channels: numeric(audio.channels),
          sampleRate: numeric(audio.sample_rate),
          kbps: numeric(audio.bit_rate) / 1000,
        }
      : null,
  };
}

/**
 * Where an encode misses `APPLE_APP_PREVIEW_SPEC` at a device size, one line
 * each; empty when it meets it. The renderer fails the app-store target on any.
 */
export function appPreviewProblems(media: ProbedMedia, size: Readonly<{ width: number; height: number }>): string[] {
  const spec = APPLE_APP_PREVIEW_SPEC;
  const problems: string[] = [];
  const { video, audio } = media;
  if (!video) return ['no video stream'];
  if (video.codec !== 'h264') problems.push(`video codec ${video.codec}, not h264`);
  if (video.profile.toLowerCase() !== spec.h264.profile) problems.push(`H.264 profile ${video.profile}, not High`);
  if (video.level > 40) problems.push(`H.264 level ${video.level / 10}, above ${spec.h264.level}`);
  if (video.width !== size.width || video.height !== size.height) {
    problems.push(`${video.width}x${video.height}, not ${size.width}x${size.height}`);
  }
  if (video.fps > spec.maxFps || video.fps <= 0) problems.push(`${video.fps} fps, above ${spec.maxFps}`);
  // x264's CBR lands a little either side of its target: allow 3% past the window.
  if (video.kbps < spec.videoKbps.min * 0.97 || video.kbps > spec.videoKbps.max * 1.03) {
    problems.push(`video ${Math.round(video.kbps)} kbit/s, outside ${spec.videoKbps.min}–${spec.videoKbps.max}`);
  }
  if (media.durationSeconds < spec.minSeconds || media.durationSeconds > spec.maxSeconds) {
    problems.push(`${media.durationSeconds.toFixed(2)} s, outside ${spec.minSeconds}–${spec.maxSeconds} s`);
  }
  if (media.sizeBytes > spec.maxBytes) problems.push(`${media.sizeBytes} bytes, over ${spec.maxBytes}`);
  if (!audio) problems.push('no audio track (Apple requires stereo AAC)');
  else {
    if (audio.codec !== spec.audio.codec) problems.push(`audio codec ${audio.codec}, not AAC`);
    if (audio.channels !== spec.audio.channels) problems.push(`${audio.channels} audio channels, not stereo`);
    if (!(spec.audio.sampleRates as readonly number[]).includes(audio.sampleRate)) {
      problems.push(`audio at ${audio.sampleRate} Hz, not 44.1 or 48 kHz`);
    }
  }
  return problems;
}
