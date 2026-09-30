import { resolve } from 'node:path';
import {
  SHOWCASE_ANCHORS_DIR,
  SHOWCASE_FOOTAGE_DIR,
  SHOWCASE_FOOTAGE_WIDTH,
  SHOWCASE_FPS,
  SHOWCASE_OUT_DIR,
  SHOWCASE_STAGE_DIR,
  SHOWCASE_WEB_POSTER_DIR,
  SHOWCASE_WEB_VIDEO_DIR,
  SHOWCASE_WORK_ROOT,
  anchorAt,
  sortAnchorSamples,
  type ShowcaseAnchorRect,
  type ShowcaseAnchorSample,
  type ShowcaseAnchorsFile,
  type ShowcaseCalloutName,
  type ShowcaseTakeId,
} from './contract';
import { HELP_CLIP_VIDEO_DIR } from '../help-clips';
import { BOARD_TYPE_LABELS } from '../../../packages/board-constants/src/board-type-labels';
import { SHOWCASE_SCENES, SHOWCASE_TOTAL_FRAMES, requiredTakeSeconds, type ShowcaseScene } from './timeline';

/**
 * Pure helpers for `packages/web/scripts/render-showcase-video.ts`: output
 * paths, stage geometry, the reading budget, callout layout, lit-hold
 * detection and every ffmpeg argument vector. Nothing here touches a browser,
 * a file or a child process, so `scripts/__tests__/showcase-video-render.test.ts`
 * can pin all of it.
 */

// --- formats and paths ---------------------------------------------------

export const SHOWCASE_FORMATS = ['16x9', '9x16'] as const;
export type ShowcaseFormat = (typeof SHOWCASE_FORMATS)[number];

export const SHOWCASE_CANVAS: Record<ShowcaseFormat, Readonly<{ width: number; height: number }>> = {
  '16x9': { width: 1920, height: 1080 },
  '9x16': { width: 1080, height: 1920 },
};

/** The page is screenshotted at 2x and downscaled with lanczos, which is what keeps hairlines and type crisp. */
export const SHOWCASE_DEVICE_SCALE = 2;

export const SHOWCASE_STAGE_HTML = resolve(SHOWCASE_STAGE_DIR, 'index.html');
export const SHOWCASE_STAGE_COPY = resolve(SHOWCASE_STAGE_DIR, 'copy.en-US.json');
export const SHOWCASE_STAGE_HOLDS = resolve(SHOWCASE_STAGE_DIR, 'holds.json');
export const SHOWCASE_STAGE_TOKENS = resolve(SHOWCASE_STAGE_DIR, 'tokens.css');
export const SHOWCASE_SHARE_COPY = resolve(SHOWCASE_STAGE_DIR, 'share-copy.txt');
export const SHOWCASE_FRAMES_DIR = resolve(SHOWCASE_WORK_ROOT, 'work/frames');
export const SHOWCASE_STILLS_DIR = resolve(SHOWCASE_OUT_DIR, 'stills');

export type ShowcaseOutputs = Readonly<{
  /** Near-lossless 1x RGB intermediate every encode reads from. */
  mezzanine: string;
  /** Full-quality masters for social and ads; frame 0 is the hook. */
  master: string;
  masterStill: string;
  shareCopy: string;
  /**
   * 9:16 only: the homepage hero, the only web outputs. The lite encode and its
   * poster (the web poster frame) ship from `packages/web/public`.
   */
  heroPoster: string | null;
  liteWebm: string | null;
  liteMp4: string | null;
  passLog: string;
}>;

export function showcaseOutputs(format: ShowcaseFormat): ShowcaseOutputs {
  const suffix = format === '16x9' ? '' : `-${format}`;
  const portrait = format === '9x16';
  return {
    mezzanine: resolve(SHOWCASE_FRAMES_DIR, `showcase${suffix}.mkv`),
    master: resolve(SHOWCASE_OUT_DIR, `brag${suffix}.mp4`),
    masterStill: resolve(SHOWCASE_OUT_DIR, `brag${suffix}.jpg`),
    shareCopy: resolve(SHOWCASE_OUT_DIR, 'share-copy.txt'),
    heroPoster: portrait ? resolve(SHOWCASE_WEB_POSTER_DIR, 'showcase-hero-9x16.webp') : null,
    liteWebm: portrait ? resolve(SHOWCASE_WEB_VIDEO_DIR, 'showcase-9x16-lite.webm') : null,
    liteMp4: portrait ? resolve(SHOWCASE_WEB_VIDEO_DIR, 'showcase-9x16-lite.mp4') : null,
    passLog: resolve(SHOWCASE_FRAMES_DIR, `showcase${suffix}-pass`),
  };
}

export const footageTakeDir = (takeId: ShowcaseTakeId): string => resolve(SHOWCASE_FOOTAGE_DIR, takeId);
export const anchorsFilePath = (takeId: ShowcaseTakeId): string => resolve(SHOWCASE_ANCHORS_DIR, `${takeId}.json`);

// --- phone geometry ------------------------------------------------------

/** CSS-drawn iPhone 16 Pro Max: 3 px titanium rim, 10 px bezel, 402x874 screen. */
export const SHOWCASE_PHONE = {
  width: 428,
  height: 900,
  screenWidth: 402,
  screenHeight: 874,
  /** Rim + bezel, from the phone's outer edge to the screen's. */
  screenInset: 13,
} as const;

export const SHOWCASE_PERSPECTIVE = 2200;

export type ShowcasePose = Readonly<{ cx: number; cy: number; scale: number; rx: number; ry: number; rz: number }>;
export type ShowcasePoseName =
  | 'OFF_RIGHT'
  | 'CALLOUT'
  | 'HERO_TILT'
  | 'BOARDS_MID'
  | 'BOARDS_LEFT'
  | 'BOARDS_RIGHT'
  | 'OFF_BOTTOM'
  | 'ISLAND';

const pose = (cx: number, cy: number, scale = 1, rx = 0, ry = 0, rz = 0): ShowcasePose => ({
  cx,
  cy,
  scale,
  rx,
  ry,
  rz,
});

export const SHOWCASE_POSES: Record<ShowcaseFormat, Record<ShowcasePoseName, ShowcasePose>> = {
  '16x9': {
    OFF_RIGHT: pose(2350, 560, 1, 4, -28, 6),
    CALLOUT: pose(1090, 540),
    HERO_TILT: pose(1400, 560, 1, 4, 14, -2),
    BOARDS_MID: pose(960, 700, 0.78),
    // The side phones sit 30 px lower than the middle one.
    BOARDS_LEFT: pose(580, 730, 0.78),
    BOARDS_RIGHT: pose(1340, 730, 0.78),
    OFF_BOTTOM: pose(960, 1760, 0.78),
    // Zoomed on the top of the phone, so the expanded Dynamic Island's buttons
    // read at phone size; the rest of the phone runs off the bottom.
    ISLAND: pose(1060, 705, 1.3),
  },
  '9x16': {
    OFF_RIGHT: pose(1560, 1300, 1.22, 4, -28, 6),
    // Below the headline, narrow enough (407 px) to leave each side room for a
    // readable pill.
    CALLOUT: pose(540, 1190, 0.95),
    HERO_TILT: pose(640, 1400, 1.02, 4, 14, -2),
    BOARDS_MID: pose(540, 1250, 0.95),
    BOARDS_LEFT: pose(300, 1330, 0.82, 0, 0, -9),
    BOARDS_RIGHT: pose(780, 1330, 0.82, 0, 0, 9),
    OFF_BOTTOM: pose(540, 2700, 0.95),
    ISLAND: pose(540, 1197, 1.55),
  },
};

/**
 * Scenes that move the phone after it lands. The island scene zooms onto the
 * expanded Dynamic Island once the footage has opened it, and its callouts wait
 * for the zoom to settle. Callout layout uses `zoomPose` for these scenes.
 */
export type SceneStaging = Readonly<{ zoomPose: ShowcasePoseName; zoomAt: number; calloutDelay: number }>;
export const SHOWCASE_SCENE_STAGING: Partial<Record<ShowcaseScene['id'], SceneStaging>> = {
  'lock-screen': { zoomPose: 'ISLAND', zoomAt: 12, calloutDelay: 16 },
};

export type CanvasRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type CanvasPoint = Readonly<{ x: number; y: number }>;

/**
 * Where a point on the phone lands on the canvas: `(x, y)` relative to the
 * phone's centre in unscaled phone pixels, projected the way the stage's CSS
 * does it (`scale() rotateX() rotateY() rotateZ()` about the centre, then the
 * stage perspective about the canvas centre). `marketing/showcase-video/anim.mjs`
 * `projectPoint` is the browser copy; the render test holds the two together.
 */
export function projectPhonePoint(
  phonePose: ShowcasePose,
  x: number,
  y: number,
  canvas: Readonly<{ width: number; height: number }>,
  perspective = SHOWCASE_PERSPECTIVE,
): CanvasPoint {
  const deg = Math.PI / 180;
  const [rz, ry, rx] = [phonePose.rz * deg, phonePose.ry * deg, phonePose.rx * deg];
  let px = x * Math.cos(rz) - y * Math.sin(rz);
  let py = x * Math.sin(rz) + y * Math.cos(rz);
  let pz = 0;
  [px, pz] = [px * Math.cos(ry) + pz * Math.sin(ry), -px * Math.sin(ry) + pz * Math.cos(ry)];
  [py, pz] = [py * Math.cos(rx) - pz * Math.sin(rx), py * Math.sin(rx) + pz * Math.cos(rx)];
  const worldX = phonePose.cx + px * phonePose.scale;
  const worldY = phonePose.cy + py * phonePose.scale;
  const factor = perspective / (perspective - pz * phonePose.scale);
  const originX = canvas.width / 2;
  const originY = canvas.height / 2;
  return { x: originX + (worldX - originX) * factor, y: originY + (worldY - originY) * factor };
}

/** A point in screen points (the app's `measureInWindow` space) to phone-local pixels. */
export function screenPointToPhone(
  point: CanvasPoint,
  screen: Readonly<{ width: number; height: number }>,
): CanvasPoint {
  const { screenWidth, screenHeight } = SHOWCASE_PHONE;
  return {
    x: -screenWidth / 2 + (point.x * screenWidth) / screen.width,
    y: -screenHeight / 2 + (point.y * screenHeight) / screen.height,
  };
}

/**
 * An anchor rect (screen points) to the canvas: the bounding box of its four
 * projected corners. Exact for the flat CALLOUT pose, a tight box otherwise.
 */
export function screenToCanvas(
  rect: ShowcaseAnchorRect,
  screen: Readonly<{ width: number; height: number }>,
  phonePose: ShowcasePose,
  canvas: Readonly<{ width: number; height: number }>,
): CanvasRect {
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width, y: rect.y + rect.height },
  ].map((corner) => {
    const local = screenPointToPhone(corner, screen);
    return projectPhonePoint(phonePose, local.x, local.y, canvas);
  });
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** True when at least `minVisible` of the anchor's area lies on the screen. */
export function anchorOnScreen(
  rect: ShowcaseAnchorRect | null,
  screen: Readonly<{ width: number; height: number }>,
  minVisible = 0.8,
): boolean {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(screen.width, rect.x + rect.width);
  const bottom = Math.min(screen.height, rect.y + rect.height);
  if (right <= left || bottom <= top) return false;
  return ((right - left) * (bottom - top)) / (rect.width * rect.height) >= minVisible;
}

/**
 * Anchors that mark only the top of what a callout means: the app logs the
 * history section's header line, but "Lit on this wall" is the list under it,
 * so its box grows downward by this many points (clamped to the screen).
 */
export const SHOWCASE_ANCHOR_EXTEND_DOWN: Partial<Record<ShowcaseCalloutName, number>> = {
  'wall-history': 300,
};

/**
 * An anchors file as the stage should read it: every list sorted by `t` (what
 * `anchorAt` needs; see `sortAnchorSamples`), moved by the take's sheet and
 * scroll corrections (`SHOWCASE_TAKE_EDITS`), and the header-only anchors grown
 * over the content they introduce. Run once on load, never per frame.
 */
export function prepareAnchorsFile(
  file: ShowcaseAnchorsFile,
  shifts: ResolvedTakeEdit['anchorShifts'] = {},
): ShowcaseAnchorsFile {
  const anchors: Partial<Record<ShowcaseCalloutName, ShowcaseAnchorSample[]>> = {};
  for (const [name, samples] of Object.entries(file.anchors) as [ShowcaseCalloutName, ShowcaseAnchorSample[]][]) {
    const extend = SHOWCASE_ANCHOR_EXTEND_DOWN[name] ?? 0;
    anchors[name] = applyAnchorShifts(sortAnchorSamples(samples), shifts[name] ?? []).map((sample) => ({
      ...sample,
      height: Math.max(sample.height, Math.min(sample.height + extend, file.screen.height - 24 - sample.y)),
    }));
  }
  return { ...file, anchors };
}

// --- footage timing ------------------------------------------------------

/**
 * A take without an edit (the boards) plays from one second in, since the
 * phone arrives before the scene's text.
 */
export const SHOWCASE_TAKE_LEAD_FRAMES = SHOWCASE_FPS;

export function footageFrameIndex(
  scene: ShowcaseScene,
  frame: number,
  frameCount: number,
  edit?: ResolvedTakeEdit,
): number {
  return footageAt(takeSegments(scene, edit), frame - scene.startFrame, frameCount);
}

// --- the edit: which footage each scene shows ---------------------------------

/**
 * Footage frames `[from, to)` of a take, 0-based (frame 0 is `00001.jpg`),
 * then `hold` frames of its last frame. A still phone screen held for a second
 * reads as the climber pausing, which gives a callout time to be read.
 */
export type FootageRange = readonly [from: number, to: number, hold?: number];

/** Scene frames a range fills: what it plays plus what it holds. */
export const rangeLength = ([from, to, hold = 0]: FootageRange): number => to - from + hold;

/**
 * The longest a scene's last segment may run past its take, held on the last
 * frame instead of failing the render (1.5 s).
 */
export const SHOWCASE_MAX_TAIL_HOLD_FRAMES = 45;

/** A moment in a take: `at` seconds after (or before, when negative) one of its marks. */
export type MarkTime = Readonly<{ mark: string; at: number }>;

/**
 * A stretch of a take relative to a mark, in seconds: `mark + from` up to
 * `mark + to`, then `hold` seconds on its last frame. A scene's last segment
 * leaves `to` out and runs until the scene is full. Lengths are counted from
 * `to - from`, not from the mark, so a re-recorded mark moves a segment without
 * changing the cut's timing. Hold only where the screen is still: a held frame
 * of a moving screen reads as a freeze.
 */
export type MarkSpan = Readonly<{ mark: string; from: number; to?: number; hold?: number }>;

/** A vertical correction for an anchor, in points, from a moment on (`from: null` is the whole take). */
export type AnchorShift = Readonly<{ from: MarkTime | null; dy: number }>;

/**
 * How a scene cuts its take, all relative to the take's marks
 * (`work/marks/<take>.json`, docs/showcase-video.md), so a re-record needs no
 * edits here: the footage it plays (hard cuts between segments), when each
 * callout may be up, and the anchor corrections the recording needs.
 */
export type TakeEdit = Readonly<{
  /** Played in order; the last one fills the scene. */
  segments: readonly MarkSpan[];
  /**
   * When each callout's target is on screen and still. A callout enters when
   * its window starts (not before the scene's first words) and retracts when it
   * ends, so a scene can point at three moments in turn.
   */
  callouts?: Partial<Record<ShowcaseCalloutName, MarkSpan>>;
  /**
   * Anchors the app measures in a native sheet's own window (y from the sheet's
   * top) or before a scroll (they re-log on layout, not on scroll): piecewise
   * `dy`; see docs/showcase-video.md.
   */
  anchorShifts?: Partial<Record<ShowcaseCalloutName, readonly AnchorShift[]>>;
  /** The rest pill the footage shows, value by value; the workouts checklist reads the same value. */
  restPill?: ReadonlyArray<Readonly<{ at: MarkTime; value: string }>>;
}>;

/** A `TakeEdit` resolved against one recording's marks: footage frames throughout. */
export type ResolvedTakeEdit = Readonly<{
  segments: readonly FootageRange[];
  callouts: Partial<Record<ShowcaseCalloutName, FootageRange>>;
  anchorShifts: Partial<Record<ShowcaseCalloutName, ReadonlyArray<Readonly<{ from: number; dy: number }>>>>;
  restPill: readonly (readonly [number, string])[];
  /** What the resolve had to bend: a last segment that ran off its footage and now holds. */
  warnings: readonly string[];
}>;

/**
 * The edit, per take. A take without an entry plays from one second in, for
 * its scene's length (the boards). Offsets are seconds from the named mark;
 * each was checked with `--measure` on the recorded frames.
 */
export const SHOWCASE_TAKE_EDITS: Partial<Record<ShowcaseTakeId, TakeEdit>> = {
  // From just before the bulb tap (it lights a few frames after), through the
  // first swipe to the next climb (`next-1`).
  light: { segments: [{ mark: 'bulb-tapped', from: -0.3 }] },
  // The climbs list, the board-button tap and the sheet opening at its middle
  // detent; cut to the sheet dragged up on "Lit on this wall".
  wall: {
    segments: [
      { mark: 'sheet-open', from: -5.4, to: 0.5 },
      { mark: 'history-shown', from: -0.5 },
    ],
    callouts: {
      // The list is still until the sheet starts up, 2.6 s before `sheet-open`.
      'board-history-button': { mark: 'sheet-open', from: -5.4, to: -2.6 },
      'now-on-wall': { mark: 'sheet-open', from: -2.4, to: 0.5 },
      'wall-history': { mark: 'history-shown', from: -0.5, to: 2.3 },
    },
    anchorShifts: {
      // The wall sheet's top: 462 pt at its middle detent, 145 pt dragged up.
      'now-on-wall': [
        { from: null, dy: 462 },
        { from: { mark: 'history-shown', at: -0.8 }, dy: 145 },
      ],
      'wall-history': [
        { from: null, dy: 462 },
        { from: { mark: 'history-shown', at: -0.8 }, dy: 145 },
      ],
    },
  },
  // The invite QR; the second phone's row landing with its avatar; the
  // long-press menu's "Play next".
  crew: {
    segments: [
      // The invite sheet starts down about 1.8 s before `invite-closed`; the
      // QR holds its last still frame until the callout has been read.
      { mark: 'invite-closed', from: -4.55, to: -2.05, hold: 0.3 },
      { mark: 'row-landed', from: -0.6, to: 2.9 },
      { mark: 'play-next-menu', from: -2.6 },
    ],
    callouts: {
      'invite-qr': { mark: 'invite-closed', from: -4.55, to: -2.05, hold: 0.3 },
      'queue-row-avatar': { mark: 'row-landed', from: 0.1, to: 2.9 },
      'play-next': { mark: 'play-next-menu', from: -2.5, to: 0.3 },
    },
    anchorShifts: {
      // The invite sheet's top, and the queue sheet's top at its detent.
      'invite-qr': [{ from: null, dy: 405 }],
      'queue-row-avatar': [{ from: null, dy: 322 }],
    },
  },
  // Pyramid picked (the target-grade row appears), then the fixed-window rest
  // pill counting. The checklist's countdown starts on the pill's first value
  // and reads `restPill`, so both show the same value on the same frame.
  workouts: {
    segments: [
      { mark: 'pyramid-picked', from: -1.9, to: 0.1 },
      { mark: 'rest-armed', from: 1.4 },
    ],
    restPill: [
      { at: { mark: 'rest-armed', at: 1.43 }, value: '0:29' },
      { at: { mark: 'rest-armed', at: 1.63 }, value: '0:28' },
      { at: { mark: 'rest-armed', at: 4.33 }, value: '0:26' },
      { at: { mark: 'rest-armed', at: 4.73 }, value: '0:25' },
    ],
  },
  // The real Dynamic Island expanded on "Masquerade"; cut to just before Next
  // and about 2.5 s of the island on "Putty".
  'lock-screen': {
    segments: [
      { mark: 'island-expanded', from: -0.3, to: 1.2 },
      { mark: 'next-tapped', from: -1.2 },
    ],
  },
  // The Progress filter after the scroll; cut to the Filters sheet with Kilter
  // picked, Done, and the calendar redrawn for Kilter.
  log: {
    segments: [
      // The page is still for 1.9 s after the scroll; its last still frame
      // holds while "Every board" is read, then the Filters sheet cuts in.
      { mark: 'scrolled', from: -1.0, to: 0.6, hold: 1.2 },
      { mark: 'filter-kilter', from: -2.2 },
    ],
    callouts: {
      'profile-board-filter': { mark: 'scrolled', from: -1.0, to: 0.6, hold: 1.2 },
      'activity-calendar': { mark: 'filter-kilter', from: -0.9, to: 1.9 },
    },
    anchorShifts: {
      // Both logged before the scroll, which moved the page up 338 pt. The
      // Kilter view drops the records card's footnote, which lifts the calendar
      // another 77 pt.
      'profile-board-filter': [{ from: { mark: 'scrolled', at: -1.5 }, dy: -338 }],
      'activity-calendar': [
        { from: { mark: 'scrolled', at: -1.5 }, dy: -338 },
        { from: { mark: 'filter-kilter', at: -1.2 }, dy: -415 },
      ],
    },
  },
};

/** Every mark an edit reads, so a render can say up front which are missing. */
export function marksNeeded(edit: TakeEdit): string[] {
  const names = [
    ...edit.segments.map((span) => span.mark),
    ...Object.values(edit.callouts ?? {}).map((span) => span.mark),
    ...Object.values(edit.anchorShifts ?? {}).flatMap((shifts) => shifts.flatMap((shift) => shift.from?.mark ?? [])),
    ...(edit.restPill ?? []).map((step) => step.at.mark),
  ];
  return [...new Set(names)];
}

/**
 * An edit against one recording: every mark-relative time becomes a footage
 * frame. Throws, naming the take and the marks, when a mark the edit needs is
 * missing or a segment runs off the footage, so a re-record that lost a step
 * fails the render instead of cutting the wrong moment.
 */
export function resolveTakeEdit(
  takeId: ShowcaseTakeId,
  edit: TakeEdit,
  marks: Readonly<Record<string, number>>,
  sceneLength: number,
  frameCount: number,
): ResolvedTakeEdit {
  const missing = marksNeeded(edit).filter((name) => typeof marks[name] !== 'number');
  if (missing.length > 0) {
    throw new Error(
      `Take "${takeId}" is missing mark(s) ${missing.join(', ')} (has: ${Object.keys(marks).join(', ') || 'none'}). ` +
        'Re-record it, or check its flow still raises them (docs/showcase-video.md).',
    );
  }
  const frameAt = (time: MarkTime) => Math.round(marks[time.mark] * SHOWCASE_FPS) + Math.round(time.at * SHOWCASE_FPS);
  const span = (value: MarkSpan, fill?: number): FootageRange => {
    const start = frameAt({ mark: value.mark, at: value.from });
    const hold = Math.round((value.hold ?? 0) * SHOWCASE_FPS);
    const length = value.to === undefined ? (fill ?? 0) - hold : Math.round((value.to - value.from) * SHOWCASE_FPS);
    return hold > 0 ? [start, start + length, hold] : [start, start + length];
  };
  const segments: FootageRange[] = [];
  edit.segments.forEach((value, index) => {
    const used = segmentsLength(segments);
    const last = index === edit.segments.length - 1;
    segments.push(span(value, last ? sceneLength - used : undefined));
  });
  const total = segmentsLength(segments);
  if (total !== sceneLength) {
    throw new Error(`Take "${takeId}": the edit plays ${total} frames, the scene needs ${sceneLength}`);
  }
  const warnings: string[] = [];
  segments.forEach(([from, to, hold = 0], index) => {
    const overrun = to - frameCount;
    const last = index === segments.length - 1;
    // The scene's tail past the take: hold the last frame, briefly, rather than fail.
    if (last && overrun > 0 && overrun <= SHOWCASE_MAX_TAIL_HOLD_FRAMES && from >= 0 && from < frameCount - 1) {
      segments[index] = [from, frameCount, hold + overrun];
      warnings.push(`take "${takeId}" ends ${overrun} frames before its scene does; holding its last frame`);
      return;
    }
    if (from < 0 || to > frameCount || to <= from) {
      throw new Error(`Take "${takeId}": segment ${from}..${to} runs off its ${frameCount} footage frames`);
    }
  });
  const callouts: Partial<Record<ShowcaseCalloutName, FootageRange>> = {};
  for (const [name, value] of Object.entries(edit.callouts ?? {}) as [ShowcaseCalloutName, MarkSpan][]) {
    callouts[name] = span(value);
  }
  const anchorShifts: ResolvedTakeEdit['anchorShifts'] = {};
  for (const [name, shifts] of Object.entries(edit.anchorShifts ?? {}) as [ShowcaseCalloutName, AnchorShift[]][]) {
    anchorShifts[name] = shifts.map((shift) => ({ from: shift.from ? frameAt(shift.from) : 0, dy: shift.dy }));
  }
  const restPill = (edit.restPill ?? []).map((step) => [frameAt(step.at), step.value] as const);
  return { segments, callouts, anchorShifts, restPill, warnings };
}

/** The footage ranges a scene plays: its resolved edit, or one second in for the scene's length. */
export function takeSegments(scene: ShowcaseScene, edit?: ResolvedTakeEdit): readonly FootageRange[] {
  if (edit) return edit.segments;
  return [[SHOWCASE_TAKE_LEAD_FRAMES, SHOWCASE_TAKE_LEAD_FRAMES + scene.endFrame - scene.startFrame]];
}

/**
 * Footage frame at a scene-local frame. Before the scene (the phone arriving)
 * it runs up to the first range; after it, on from the last, or still held
 * when the last range holds. Clamped to the take. `anim.mjs` `footageAt` is
 * the stage's copy; the render test holds the two together.
 */
export function footageAt(segments: readonly FootageRange[], local: number, frameCount: number): number {
  const clamp = (value: number) => Math.max(0, Math.min(frameCount - 1, value));
  if (local < 0 || segments.length === 0) return clamp((segments[0]?.[0] ?? 0) + local);
  let offset = 0;
  for (const range of segments) {
    const [from, to] = range;
    if (local < offset + rangeLength(range)) return clamp(Math.min(from + local - offset, to - 1));
    offset += rangeLength(range);
  }
  const [, lastTo, lastHold = 0] = segments[segments.length - 1];
  return clamp(lastHold > 0 ? lastTo - 1 : lastTo + local - offset);
}

/** Scene-local frame at which footage frame `footage` first plays, or null when the edit skips it. */
export function localAtFootage(segments: readonly FootageRange[], footage: number): number | null {
  let offset = 0;
  for (const range of segments) {
    const [from, to] = range;
    if (footage >= from && footage < to) return offset + footage - from;
    offset += rangeLength(range);
  }
  return null;
}

export const segmentsLength = (segments: readonly FootageRange[]): number =>
  segments.reduce((sum, range) => sum + rangeLength(range), 0);

/**
 * Samples with piecewise shifts applied: a sample at every original and shift
 * time, each the rect in force then, moved by the shift in force then. Shift
 * times are footage frames.
 */
export function applyAnchorShifts(
  samples: readonly ShowcaseAnchorSample[],
  shifts: ReadonlyArray<Readonly<{ from: number; dy: number }>>,
): ShowcaseAnchorSample[] {
  if (shifts.length === 0 || samples.length === 0) return samples.slice();
  const sorted = sortAnchorSamples(samples);
  const times = [
    ...new Set([...sorted.map((sample) => sample.t), ...shifts.map((shift) => shift.from / SHOWCASE_FPS)]),
  ].sort((a, b) => a - b);
  return times.map((t) => {
    const rect = anchorAt(sorted, t) as ShowcaseAnchorRect;
    const shift = shifts.filter((candidate) => candidate.from / SHOWCASE_FPS <= t + 1e-9).at(-1);
    return { ...rect, t, y: rect.y + (shift?.dy ?? 0) };
  });
}

export type CalloutTiming = Readonly<{ enter: number; exit: number; at: number }>;

/**
 * When each callout is up, in scene-local frames, and the footage time (s) its
 * anchor is laid out at. Without a window: the template's staggered entrance.
 * With one: in as the window opens (not before local 8), out as it closes.
 */
export function calloutTimings(
  scene: ShowcaseScene,
  names: readonly ShowcaseCalloutName[],
  edit?: ResolvedTakeEdit,
): Partial<Record<ShowcaseCalloutName, CalloutTiming>> {
  const segments = takeSegments(scene, edit);
  const length = scene.endFrame - scene.startFrame;
  const lastExit = length - SHOWCASE_CHOREO.calloutsOutEndFromEnd;
  const delay = SHOWCASE_SCENE_STAGING[scene.id]?.calloutDelay ?? 0;
  const timings: Partial<Record<ShowcaseCalloutName, CalloutTiming>> = {};
  names.forEach((name, index) => {
    const window = edit?.callouts[name];
    const windowStart = window ? localAtFootage(segments, window[0]) : null;
    if (window && windowStart !== null) {
      const windowEnd = windowStart + rangeLength(window);
      const enter = Math.max(windowStart + 4, 8);
      timings[name] = {
        enter,
        exit: Math.min(windowEnd, lastExit),
        at: footageAt(segments, enter + 10, Number.MAX_SAFE_INTEGER) / SHOWCASE_FPS,
      };
      return;
    }
    const enter = SHOWCASE_CHOREO.calloutStart + delay + SHOWCASE_CHOREO.calloutStagger * index;
    timings[name] = { enter, exit: lastExit, at: footageAt(segments, enter, Number.MAX_SAFE_INTEGER) / SHOWCASE_FPS };
  });
  return timings;
}

// --- choreography and the reading budget ----------------------------------

/** Local frames, per the brag-slim template. Shared with the stage via the injected data. */
export const SHOWCASE_CHOREO = {
  firstWord: 6,
  wordStagger: 2,
  wordFrames: 14,
  accentDelay: 4,
  accentFrames: 18,
  calloutStart: 18,
  /** Half a second between callout entrances. */
  calloutStagger: 15,
  boxFrames: 8,
  leaderDelay: 6,
  leaderFrames: 10,
  pillDelay: 14,
  settleEndFromEnd: 14,
  calloutsOutFromEnd: 14,
  calloutsOutEndFromEnd: 8,
  wordsOutFromEnd: 12,
  wordsOutEndFromEnd: 3,
  backgroundLeadIn: 4,
  backgroundLeadOut: 6,
  newTextNotBefore: 3,
  /** The outro's last 24 frames lead back into frame 0. */
  loopCloserFrames: 24,
} as const;

export const SHOWCASE_SECONDS_PER_WORD = 0.3;

/**
 * A callout stays fully settled (box, leader and pill all in) for at least
 * max(1.6 s, 0.45 s a word) before it or anything else in its scene exits.
 */
export const SHOWCASE_CALLOUT_MIN_SECONDS = 1.6;
export const SHOWCASE_CALLOUT_SECONDS_PER_WORD = 0.45;

/** Frames from a callout's `enter` until its box, leader and pill are all in (stage `renderCallouts`). */
export const SHOWCASE_CALLOUT_SETTLE_FRAMES = Math.max(
  SHOWCASE_CHOREO.boxFrames,
  SHOWCASE_CHOREO.leaderDelay + SHOWCASE_CHOREO.leaderFrames,
  SHOWCASE_CHOREO.pillDelay + 6,
);

/** Frames a callout's retract takes; it starts this long before the callout's `exit`. */
export const SHOWCASE_CALLOUT_RETRACT_FRAMES =
  SHOWCASE_CHOREO.calloutsOutFromEnd - SHOWCASE_CHOREO.calloutsOutEndFromEnd;

export function calloutReadingFrames(words: number): number {
  return Math.ceil(Math.max(SHOWCASE_CALLOUT_MIN_SECONDS, words * SHOWCASE_CALLOUT_SECONDS_PER_WORD) * SHOWCASE_FPS);
}

/** Words a viewer has to read: runs of letters or digits, so "&" and "·" are free. */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? []).length;
}

type CalloutCopy = Partial<Record<ShowcaseCalloutName, string>>;
type SceneCopy = Readonly<{ headline: string; callouts?: CalloutCopy }>;

/** One step of the workouts checklist: a name, the grade chip, and the rest that follows it. */
export type WorkoutRow = Readonly<{ name: string; grade: string; rest: string }>;

export type ShowcaseCopy = Readonly<{
  hook: SceneCopy;
  light: SceneCopy;
  boards: SceneCopy;
  wall: SceneCopy;
  crew: SceneCopy;
  workouts: SceneCopy &
    Readonly<{
      rows: readonly WorkoutRow[];
      /** Label on the rest countdown, and the values it counts through. */
      restLabel: string;
      restCountdown: readonly string[];
    }>;
  'lock-screen': SceneCopy;
  log: SceneCopy;
  outro: Readonly<{
    wordmark: string;
    tagline: string;
    pill: string;
    /**
     * The small line under the pill: who pays for Boardsesh, worded as the
     * homepage's `proofNoCount`. Never a tax or perk claim. Store previews and
     * install ads must not mention donations, so `--no-donation-line` drops it.
     */
    donation?: string;
  }>;
}>;

/** The copy for a cut without the donation line (`--no-donation-line`): store previews, install ads. */
export function withoutDonationLine(copy: ShowcaseCopy): ShowcaseCopy {
  const { donation: _dropped, ...outro } = copy.outro;
  return { ...copy, outro };
}

/** `boards-soill` → "So iLL", from the one brand-name map the apps use. */
export function boardTakeLabel(takeId: ShowcaseTakeId): string {
  const boardType = takeId.replace(/^boards-/, '');
  return BOARD_TYPE_LABELS[boardType] ?? boardType;
}

export const sceneCalloutCopy = (copy: ShowcaseCopy, sceneId: ShowcaseScene['id']): CalloutCopy =>
  sceneId === 'outro' ? {} : (copy[sceneId].callouts ?? {});

/**
 * The text on screen once a scene has settled. Grade chips, rest times and
 * timestamps are glanced at, not read, so they do not count.
 */
export function sceneVisibleText(
  scene: ShowcaseScene,
  copy: ShowcaseCopy,
  callouts: readonly ShowcaseCalloutName[] = scene.callouts,
  boardTakes: readonly ShowcaseTakeId[] = scene.takes,
): string[] {
  if (scene.id === 'outro') {
    return [
      copy.outro.wordmark,
      copy.outro.tagline,
      copy.outro.pill,
      ...(copy.outro.donation ? [copy.outro.donation] : []),
    ];
  }
  const labels = sceneCalloutCopy(copy, scene.id);
  const text = [copy[scene.id].headline, ...callouts.map((name) => labels[name] ?? '')];
  if (scene.id === 'boards') text.push(...boardTakes.map(boardTakeLabel));
  if (scene.id === 'workouts') text.push(...copy.workouts.rows.map((row) => row.name), copy.workouts.restLabel);
  return text;
}

/**
 * Frames the scene's text is on screen and still: from the first word landing
 * (frame 0 for the hook, whose frame 0 is the settled poster) to the start of
 * the exit (the loop closer for the outro).
 */
export function readingWindowFrames(scene: ShowcaseScene): number {
  const length = scene.endFrame - scene.startFrame;
  const start = scene.id === 'hook' ? 0 : SHOWCASE_CHOREO.firstWord;
  const end =
    scene.id === 'outro' ? length - SHOWCASE_CHOREO.loopCloserFrames : length - SHOWCASE_CHOREO.wordsOutFromEnd;
  return end - start;
}

export function readingBudgetFrames(words: number): number {
  return Math.ceil(words * SHOWCASE_SECONDS_PER_WORD * SHOWCASE_FPS);
}

export type CalloutReadingReport = Readonly<{
  name: ShowcaseCalloutName;
  words: number;
  /** Scene-local frames: in, fully settled, and when it (or the scene's text) starts out. */
  enter: number;
  settledFrom: number;
  settledUntil: number;
  settledFrames: number;
  needFrames: number;
}>;

export type ReadingBudgetReport = Readonly<{
  sceneId: ShowcaseScene['id'];
  /** Words outside the callouts: the headline, plus the boards' names, the workout rows, the end card. */
  headlineWords: number;
  calloutWords: number;
  words: number;
  needFrames: number;
  haveFrames: number;
  callouts: readonly CalloutReadingReport[];
}>;

/**
 * Per callout: how long it sits fully settled, from its box, leader and pill
 * being in until its own retract or the scene's words going out, whichever is
 * first; and how long its words need.
 */
export function calloutReadingReports(
  scene: ShowcaseScene,
  labels: CalloutCopy,
  edit?: ResolvedTakeEdit,
  names: readonly ShowcaseCalloutName[] = scene.callouts,
): CalloutReadingReport[] {
  const length = scene.endFrame - scene.startFrame;
  const timings = calloutTimings(scene, names, edit);
  return names.flatMap((name) => {
    const timing = timings[name];
    if (!timing) return [];
    const words = countWords(labels[name] ?? '');
    const settledFrom = timing.enter + SHOWCASE_CALLOUT_SETTLE_FRAMES;
    const settledUntil = Math.min(
      timing.exit - SHOWCASE_CALLOUT_RETRACT_FRAMES,
      length - SHOWCASE_CHOREO.wordsOutFromEnd,
    );
    return [
      {
        name,
        words,
        enter: timing.enter,
        settledFrom,
        settledUntil,
        settledFrames: settledUntil - settledFrom,
        needFrames: calloutReadingFrames(words),
      },
    ];
  });
}

/**
 * The reading budget, per scene: the scene's words (headline plus every
 * callout label) against the time its text is still, and each callout's
 * settled time against its own need. `edits` are the resolved take edits, so
 * windowed callouts are measured on the cut the render plays.
 */
export function readingBudgetReport(
  copy: ShowcaseCopy,
  scenes: readonly ShowcaseScene[] = SHOWCASE_SCENES,
  edits: Partial<Record<ShowcaseTakeId, ResolvedTakeEdit>> = {},
): ReadingBudgetReport[] {
  const wordsIn = (texts: readonly string[]) =>
    texts.map((text) => countWords(text.replace(/\*/g, ''))).reduce((sum, count) => sum + count, 0);
  return scenes.map((scene) => {
    // Every board phone and every callout present: the worst case.
    const words = wordsIn(sceneVisibleText(scene, copy));
    const labels = sceneCalloutCopy(copy, scene.id);
    const calloutWords = wordsIn(scene.callouts.map((name) => labels[name] ?? ''));
    return {
      sceneId: scene.id,
      headlineWords: words - calloutWords,
      calloutWords,
      words,
      needFrames: readingBudgetFrames(words),
      haveFrames: readingWindowFrames(scene),
      callouts: calloutReadingReports(scene, labels, scene.takes[0] ? edits[scene.takes[0]] : undefined),
    };
  });
}

/** Whether a scene and all its callouts meet the budget. */
export const readingBudgetMet = (report: ReadingBudgetReport): boolean =>
  report.haveFrames >= report.needFrames &&
  report.callouts.every((callout) => callout.settledFrames >= callout.needFrames);

/**
 * The budget as a plain-text table: one row per scene (headline words, callout
 * words, seconds the text is settled, seconds it needs), then one row per
 * callout (its words, seconds fully settled, seconds it needs).
 */
export function formatReadingBudgetTable(reports: readonly ReadingBudgetReport[]): string {
  const seconds = (frames: number) => (frames / SHOWCASE_FPS).toFixed(2);
  const rows: string[][] = [['scene / callout', 'headline words', 'callout words', 'settled s', 'required s', '']];
  for (const report of reports) {
    rows.push([
      report.sceneId,
      String(report.headlineWords),
      String(report.calloutWords),
      seconds(report.haveFrames),
      seconds(report.needFrames),
      report.haveFrames >= report.needFrames ? 'ok' : 'SHORT',
    ]);
    for (const callout of report.callouts) {
      rows.push([
        `  ${callout.name}`,
        '',
        String(callout.words),
        seconds(callout.settledFrames),
        seconds(callout.needFrames),
        callout.settledFrames >= callout.needFrames ? 'ok' : 'SHORT',
      ]);
    }
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

// --- headline parsing ------------------------------------------------------

export type HeadlineWord = Readonly<{ text: string; accent: boolean }>;

/**
 * `"Your board.\nLit from your *phone.*"` → lines of words. `*...*` marks the
 * accent word (Instrument Serif Italic); `\n` is a forced line break.
 */
export function parseHeadline(headline: string): HeadlineWord[][] {
  return headline.split('\n').map((line) => {
    const words: HeadlineWord[] = [];
    for (const match of line.matchAll(/\*([^*]+)\*|(\S+)/g)) {
      if (match[1]) words.push({ text: match[1], accent: true });
      else if (match[2]) words.push({ text: match[2], accent: false });
    }
    return words;
  });
}

// --- callouts ----------------------------------------------------------------

export type CalloutRole = 'start' | 'hand' | 'finish';
export const CALLOUT_ROLES: readonly CalloutRole[] = ['start', 'hand', 'finish'];

/**
 * Role hues for callouts on the lavender scenes. The LED hues (#00FF00,
 * #4DF5FD, #FF00FF) vanish on #F4F1FB, so light scenes draw the same roles a
 * step darker: each clears 3:1 against the background (the render test checks).
 * Start is the Velvet Send light `success`.
 */
export const SHOWCASE_LIGHT_ROLE_COLORS: Record<CalloutRole, string> = {
  start: '#047857',
  hand: '#0E7490',
  finish: '#A21CAF',
};
export const SHOWCASE_STAGE_LIGHT = '#F4F1FB';

/** WCAG 2 contrast ratio between two `#RRGGBB` colours. */
export function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const [red, green, blue] = channels.map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Callout geometry. Sized to be read on a phone: the 16:9 cut shown 390 CSS px
 * wide scales by 390/1920, so the 36 px label renders at 7.3 px; the 9:16 cut
 * scales by 390/1080, so its 32 px label renders at 11.6 px (`calloutLabelCssPx`).
 */
export const SHOWCASE_CALLOUT_LAYOUT = {
  boxPadding: 8,
  gutterX: 1340,
  /** Spacing between leader verticals when two would otherwise share the gutter. */
  gutterPitch: 20,
  pillX: 1400,
  pillHeight: 84,
  labelSize: 36,
  /** 9:16: pills sit this far in from the canvas edge. */
  portraitPillInset: 14,
  portraitPillWidth: 336,
  portraitPillHeight: 72,
  portraitLabelSize: 32,
  portraitMinGap: 88,
} as const;

/** CSS px a callout label renders at when the video plays `viewerWidth` CSS px wide. */
export function calloutLabelCssPx(format: ShowcaseFormat, viewerWidth = 390): number {
  const { labelSize, portraitLabelSize } = SHOWCASE_CALLOUT_LAYOUT;
  const size = format === '16x9' ? labelSize : portraitLabelSize;
  return (size * viewerWidth) / SHOWCASE_CANVAS[format].width;
}

/**
 * Pill slots for a scene. When the boxes sit low on the screen (the lock
 * screen's buttons), the column slides down with them, up to 180 px, so the
 * leaders stay short.
 */
export function calloutSlots(count: number, meanBoxY = 540): number[] {
  if (count <= 0) return [];
  const base = count === 1 ? [540] : count === 2 ? [420, 660] : [360, 540, 720].slice(0, count);
  const shift = Math.max(0, Math.min(180, meanBoxY - 540));
  return base.map((slot) => slot + shift);
}

type Segment = Readonly<{ x1: number; y1: number; x2: number; y2: number }>;

/**
 * How a leader leaves its box: from the side (the usual case), or from the top
 * when running sideways would cut through another callout's box (a row of
 * buttons, like the lock screen's).
 */
export type LeaderExit = 'side' | 'top' | 'bottom';

/** The 16:9 leader, as the stage draws it: box → gutter → pill slot → pill. */
export function leaderPoints(
  box: CanvasRect,
  exit: LeaderExit,
  laneY: number,
  gutterX: number,
  slotY: number,
  pillX: number,
): CanvasPoint[] {
  if (exit === 'top') {
    const x = box.x + box.width / 2;
    return [
      { x, y: box.y },
      { x, y: laneY },
      { x: gutterX, y: laneY },
      { x: gutterX, y: slotY },
      { x: pillX, y: slotY },
    ];
  }
  const y = box.y + box.height / 2;
  return [
    { x: box.x + box.width, y },
    { x: gutterX, y },
    { x: gutterX, y: slotY },
    { x: pillX, y: slotY },
  ];
}

const toSegments = (points: readonly CanvasPoint[]): Segment[] =>
  points.slice(1).map((point, index) => ({ x1: points[index].x, y1: points[index].y, x2: point.x, y2: point.y }));

function segmentsCross(a: Segment, b: Segment): boolean {
  const aHorizontal = a.y1 === a.y2;
  const bHorizontal = b.y1 === b.y2;
  const within = (value: number, from: number, to: number) =>
    value > Math.min(from, to) + 0.5 && value < Math.max(from, to) - 0.5;
  if (aHorizontal === bHorizontal) {
    // Parallel: they only collide when they share a line and overlap.
    if (aHorizontal) {
      return (
        Math.abs(a.y1 - b.y1) < 6 &&
        Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2)) < Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2))
      );
    }
    return (
      Math.abs(a.x1 - b.x1) < 6 &&
      Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2)) < Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2))
    );
  }
  const horizontal = aHorizontal ? a : b;
  const vertical = aHorizontal ? b : a;
  return within(vertical.x1, horizontal.x1, horizontal.x2) && within(horizontal.y1, vertical.y1, vertical.y2);
}

/** True when a horizontal run at `y` between `fromX` and `toX` passes through `box`. */
function runHitsBox(fromX: number, toX: number, y: number, box: CanvasRect): boolean {
  const left = Math.min(fromX, toX);
  const right = Math.max(fromX, toX);
  return y > box.y && y < box.y + box.height && right > box.x + 1 && left < box.x + box.width - 1;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

export type LeaderPlan = Readonly<{ exit: LeaderExit; laneY: number; gutterX: number; slotY: number }>;

/**
 * 16:9 leaders for one scene's (padded) boxes. A box whose sideways run would
 * cut through another box leaves from its top on its own lane (the leftmost
 * box on the highest lane, so the risers never cross). Then every order of
 * pill slots and gutter offsets is tried and the one with the fewest crossings
 * wins, preferring slots in callout order and gutters near the nominal x.
 * With at most three callouts that is 36 layouts: cheap and exact.
 */
export function planLeaders(
  boxes: readonly CanvasRect[],
  layout: Readonly<{ gutterX: number; gutterPitch: number; pillX: number }> = SHOWCASE_CALLOUT_LAYOUT,
): LeaderPlan[] {
  const exits: LeaderExit[] = boxes.map((box, index) =>
    boxes.some(
      (other, otherIndex) =>
        otherIndex !== index && runHitsBox(box.x + box.width, layout.gutterX, box.y + box.height / 2, other),
    )
      ? 'top'
      : 'side',
  );
  const topOfAll = Math.min(...boxes.map((box) => box.y));
  const lanes = boxes.map((box, index) => {
    if (exits[index] !== 'top') return 0;
    const risersToTheRight = boxes.filter((other, otherIndex) => exits[otherIndex] === 'top' && other.x > box.x).length;
    return topOfAll - 22 - 18 * risersToTheRight;
  });
  const meanY = boxes.reduce((sum, box) => sum + box.y + box.height / 2, 0) / Math.max(1, boxes.length);
  const slots = calloutSlots(boxes.length, meanY);
  const offsets = boxes.map((_, index) => layout.gutterX - index * layout.gutterPitch);
  let best: LeaderPlan[] = boxes.map((_, index) => ({
    exit: exits[index],
    laneY: lanes[index],
    gutterX: offsets[index],
    slotY: slots[index],
  }));
  let bestScore = Number.POSITIVE_INFINITY;
  for (const slotOrder of permutations(slots)) {
    for (const gutters of permutations(offsets)) {
      const paths = boxes.map((box, index) =>
        toSegments(leaderPoints(box, exits[index], lanes[index], gutters[index], slotOrder[index], layout.pillX)),
      );
      let crossings = 0;
      for (let first = 0; first < paths.length; first += 1) {
        for (let second = first + 1; second < paths.length; second += 1) {
          for (const a of paths[first]) for (const b of paths[second]) if (segmentsCross(a, b)) crossings += 1;
        }
      }
      const slotDrift = slotOrder.reduce((sum, slot, index) => sum + Math.abs(slot - slots[index]), 0);
      const gutterDrift = gutters.reduce(
        (sum, value, index) => sum + Math.abs(value - layout.gutterX) * (index + 1),
        0,
      );
      const score = crossings * 10_000 + slotDrift + gutterDrift;
      if (score < bestScore) {
        bestScore = score;
        best = boxes.map((_, index) => ({
          exit: exits[index],
          laneY: lanes[index],
          gutterX: gutters[index],
          slotY: slotOrder[index],
        }));
      }
    }
  }
  return best;
}

export type PortraitPill = Readonly<{ side: 'left' | 'right'; y: number; exit: LeaderExit }>;

/**
 * 9:16 callouts: pills alternate left/right beside the phone on short leaders,
 * each level with its box where possible, nudged apart on the same side.
 *
 * A side only counts when the pill fits between the canvas edge and the phone
 * (it may overlap the rim, not the screen) and its run does not cross another
 * box. With no side clear, the pill stacks above the boxes on a riser from the
 * box top; with no side roomy at all (the zoomed island), the pills stack below
 * the boxes, over the screen under them, on risers from the box bottoms.
 */
export function layoutPortraitPills(
  boxes: readonly CanvasRect[],
  canvas: Readonly<{ width: number; height: number }>,
  phone: CanvasRect | null = null,
  layout: Readonly<{
    portraitPillInset: number;
    portraitPillWidth: number;
    portraitMinGap: number;
  }> = SHOWCASE_CALLOUT_LAYOUT,
): PortraitPill[] {
  const { portraitPillInset: inset, portraitPillWidth: width, portraitMinGap: minGap } = layout;
  const leftEdge = inset + width;
  const rightEdge = canvas.width - inset - width;
  const rimAllowance = 24;
  const roomy = (side: 'left' | 'right') =>
    !phone ||
    (side === 'left' ? leftEdge <= phone.x + rimAllowance : rightEdge >= phone.x + phone.width - rimAllowance);
  const clear = (index: number, side: 'left' | 'right') => {
    const box = boxes[index];
    const y = box.y + box.height / 2;
    const [from, to] = side === 'left' ? [box.x, leftEdge] : [box.x + box.width, rightEdge];
    return roomy(side) && !boxes.some((other, otherIndex) => otherIndex !== index && runHitsBox(from, to, y, other));
  };
  const topOfAll = Math.min(...boxes.map((box) => box.y));
  const bottomOfAll = Math.max(...boxes.map((box) => box.y + box.height));
  const centreX = (box: CanvasRect) => box.x + box.width / 2;
  const dropSide = (box: CanvasRect): 'left' | 'right' => (centreX(box) < canvas.width / 2 ? 'left' : 'right');
  // Dropped pills stack down each side, the box nearest that edge first, so no
  // riser crosses another pill's run.
  const dropOrder = (index: number) => {
    const box = boxes[index];
    const side = dropSide(box);
    return boxes
      .filter((other) => dropSide(other) === side)
      .map(centreX)
      .sort((a, b) => (side === 'left' ? a - b : b - a))
      .indexOf(centreX(box));
  };
  const placed: PortraitPill[] = [];
  let risers = 0;
  boxes.forEach((box, index) => {
    const preferred = index % 2 === 0 ? 'left' : 'right';
    const other = preferred === 'left' ? 'right' : 'left';
    const side = clear(index, preferred) ? preferred : clear(index, other) ? other : null;
    if (!side && !roomy('left') && !roomy('right')) {
      placed.push({ side: dropSide(box), y: bottomOfAll + 64 + minGap * dropOrder(index), exit: 'bottom' });
      return;
    }
    if (!side) {
      const riserSide = box.x + box.width / 2 < canvas.width / 2 ? 'left' : 'right';
      placed.push({ side: riserSide, y: topOfAll - 56 - minGap * risers, exit: 'top' });
      risers += 1;
      return;
    }
    let y = box.y + box.height / 2;
    for (const pill of placed) {
      if (pill.side === side && Math.abs(pill.y - y) < minGap) y = pill.y + minGap;
    }
    placed.push({ side, y: Math.max(minGap, Math.min(canvas.height - minGap, y)), exit: 'side' });
  });
  return placed;
}

// --- lit-hold detection ------------------------------------------------------

export type LitHold = Readonly<{ x: number; y: number; role: CalloutRole }>;

function hueSaturationValue(red: number, green: number, blue: number): [number, number, number] {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return [hue, max === 0 ? 0 : delta / max, max / 255];
}

/** Which role a glow pixel belongs to, by hue. Foot holds (amber) and everything dull return null. */
export function classifyGlowPixel(red: number, green: number, blue: number): CalloutRole | null {
  const [hue, saturation, value] = hueSaturationValue(red, green, blue);
  if (saturation < 0.55 || value < 0.45) return null;
  if (hue >= 95 && hue <= 150) return 'start';
  if (hue >= 172 && hue <= 200) return 'hand';
  if (hue >= 285 && hue <= 330) return 'finish';
  return null;
}

/**
 * Finds the lit holds in one footage frame: connected blobs of start-green,
 * hand-cyan and finish-magenta glow inside `region` (pixel coordinates), each
 * reported at its centroid. `pixels` is packed RGB or RGBA, row-major.
 */
export function detectLitHolds(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  region: CanvasRect = { x: 0, y: 0, width, height },
  minArea = 12,
): LitHold[] {
  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(width, Math.ceil(region.x + region.width));
  const bottom = Math.min(height, Math.ceil(region.y + region.height));
  const labels = new Int8Array(width * height).fill(-1);
  const roleIndex = (role: CalloutRole) => CALLOUT_ROLES.indexOf(role);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * width + x) * channels;
      const role = classifyGlowPixel(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      if (role) labels[y * width + x] = roleIndex(role);
    }
  }
  const seen = new Uint8Array(width * height);
  const holds: LitHold[] = [];
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const start = y * width + x;
      if (labels[start] < 0 || seen[start]) continue;
      const label = labels[start];
      const stack = [start];
      seen[start] = 1;
      let area = 0;
      let sumX = 0;
      let sumY = 0;
      while (stack.length > 0) {
        const index = stack.pop() as number;
        const px = index % width;
        const py = (index - px) / width;
        area += 1;
        sumX += px;
        sumY += py;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < left || nx >= right || ny < top || ny >= bottom) continue;
          const neighbour = ny * width + nx;
          if (seen[neighbour] || labels[neighbour] !== label) continue;
          seen[neighbour] = 1;
          stack.push(neighbour);
        }
      }
      if (area >= minArea) holds.push({ x: sumX / area, y: sumY / area, role: CALLOUT_ROLES[label] });
    }
  }
  return orderHoldsForClimb(holds);
}

/** Climbing order for the motif line: starts, then hands bottom-up, then finishes left to right. */
export function orderHoldsForClimb(holds: readonly LitHold[]): LitHold[] {
  const rank = (hold: LitHold) => CALLOUT_ROLES.indexOf(hold.role);
  return holds.slice().sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.role === 'finish') return a.x - b.x;
    return b.y - a.y || a.x - b.x;
  });
}

// --- stage data ----------------------------------------------------------------

export type StageCallout = Readonly<{
  name: ShowcaseCalloutName;
  label: string;
  role: CalloutRole;
  /** 16:9: pill slot y and the leader's gutter x. 9:16: pill side and y. */
  slotY: number;
  gutterX: number;
  side: 'left' | 'right';
  /** Side exit, or a riser from the box top (to `laneY` in 16:9, to the pill in 9:16). */
  exit: LeaderExit;
  laneY: number;
  /** Scene-local frames the callout draws in and has retracted by. */
  enter: number;
  leave: number;
}>;

export type StageTake = Readonly<{
  frameUrlBase: string;
  frameCount: number;
  /** Footage ranges the take's scene plays (`takeSegments`). */
  segments: readonly FootageRange[];
  screen: Readonly<{ width: number; height: number }>;
  anchors: Partial<Record<ShowcaseCalloutName, readonly ShowcaseAnchorSample[]>>;
}>;

/**
 * The boards pile-up: which phones arrive, in what order, and where they end
 * up left to right. Only takes with footage are listed.
 */
export type StageBoards = Readonly<{
  /** Arrival order: the first `neatCount` rise together, the rest crowd in. */
  arrival: readonly ShowcaseTakeId[];
  /** Left-to-right order once everyone has squeezed in. */
  final: readonly ShowcaseTakeId[];
  /** The persistent phone's take (it carries on from the previous scene). */
  main: ShowcaseTakeId;
  neatCount: number;
  /** Local frame each phone arrives at, in arrival order (see `pileupArrivalFrames`). */
  arrivalFrames: readonly number[];
  labels: Readonly<Partial<Record<ShowcaseTakeId, string>>>;
}>;

/** Everything `window.showcaseInit(data)` receives; the page reads nothing else. */
export type ShowcaseStageData = Readonly<{
  format: ShowcaseFormat;
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  perspective: number;
  measure: boolean;
  choreo: typeof SHOWCASE_CHOREO;
  layout: typeof SHOWCASE_CALLOUT_LAYOUT;
  phone: typeof SHOWCASE_PHONE;
  poses: Record<ShowcasePoseName, ShowcasePose>;
  scenes: ReadonlyArray<
    Readonly<{
      id: ShowcaseScene['id'];
      startFrame: number;
      endFrame: number;
      background: ShowcaseScene['background'];
      takes: readonly ShowcaseTakeId[];
      callouts: readonly StageCallout[];
    }>
  >;
  takes: Partial<Record<ShowcaseTakeId, StageTake>>;
  boards: StageBoards;
  workout: ReturnType<typeof workoutTickFrames>;
  workoutBeats: typeof SHOWCASE_WORKOUT_BEATS;
  staging: typeof SHOWCASE_SCENE_STAGING;
  /** The workouts footage's rest pill, for the checklist countdown (`TakeEdit.restPill`). */
  restPill: readonly (readonly [number, string])[];
  /** Light-scene callout hues; dark scenes use the tokens' LED hues. */
  lightRoles: Record<CalloutRole, string>;
  /** Lit holds of the light take's first frame, in screen points. */
  holds: readonly LitHold[];
  copy: ShowcaseCopy;
  grades: Record<string, Readonly<{ background: string; ink: string }>>;
  /** The two backgrounds the stage tweens between, in OKLab. */
  palette: Readonly<{ stageDark: string; stageLight: string }>;
  markUrl: string;
}>;

/**
 * Callouts that can be drawn: the scene asks for them and the take reports the
 * anchor on screen when the callouts arrive. Anything else is skipped with a
 * warning rather than pointing a leader at nothing.
 */
export function resolveSceneCallouts(
  scene: ShowcaseScene,
  anchorsFile: ShowcaseAnchorsFile | null,
  labels: CalloutCopy,
  edit?: ResolvedTakeEdit,
): { callouts: ShowcaseCalloutName[]; warnings: string[] } {
  const callouts: ShowcaseCalloutName[] = [];
  const warnings: string[] = [];
  const take = scene.takes[0];
  const timings = calloutTimings(scene, scene.callouts, edit);
  for (const name of scene.callouts) {
    const samples = anchorsFile?.anchors[name];
    const rect = samples ? anchorAt(samples, timings[name]?.at ?? 0) : null;
    if (!labels[name]) warnings.push(`${scene.id}: no copy for callout "${name}"; skipped`);
    else if (!anchorsFile || !rect)
      warnings.push(`${scene.id}: take "${take}" never reports anchor "${name}"; skipped`);
    else if (!anchorOnScreen(rect, anchorsFile.screen))
      warnings.push(`${scene.id}: anchor "${name}" is off screen in take "${take}"; skipped`);
    else callouts.push(name);
  }
  return { callouts, warnings };
}

/** Pill slots and leader gutters for a scene's callouts, from where the anchors sit when the callouts land. */
export function layoutSceneCallouts(
  format: ShowcaseFormat,
  scene: ShowcaseScene,
  names: readonly ShowcaseCalloutName[],
  anchorsFile: ShowcaseAnchorsFile,
  labels: CalloutCopy,
  edit?: ResolvedTakeEdit,
): StageCallout[] {
  const canvas = SHOWCASE_CANVAS[format];
  const calloutPose = SHOWCASE_POSES[format][SHOWCASE_SCENE_STAGING[scene.id]?.zoomPose ?? 'CALLOUT'];
  const timings = calloutTimings(scene, names, edit);
  const timing = (name: ShowcaseCalloutName) => {
    const found = timings[name];
    if (!found) throw new Error(`No timing for callout ${name}`);
    return found;
  };
  const boxes = names.map((name) => {
    const rect = anchorAt(anchorsFile.anchors[name] ?? [], timing(name).at);
    if (!rect) throw new Error(`Anchor ${name} has no samples`);
    return screenToCanvas(rect, anchorsFile.screen, calloutPose, canvas);
  });
  const roles = names.map((_, index) => CALLOUT_ROLES[Math.min(index, CALLOUT_ROLES.length - 1)]);
  // The boxes as the stage draws them: padded.
  const pad = SHOWCASE_CALLOUT_LAYOUT.boxPadding;
  const padded = boxes.map((box) => ({
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  }));
  if (format === '16x9') {
    const plans = planLeaders(padded);
    return names.map((name, index) => ({
      name,
      label: labels[name] ?? name,
      role: roles[index],
      side: 'right',
      ...plans[index],
      enter: timing(name).enter,
      leave: timing(name).exit,
    }));
  }
  const { width: phoneWidth, height: phoneHeight } = SHOWCASE_PHONE;
  const phone = {
    x: calloutPose.cx - (phoneWidth / 2) * calloutPose.scale,
    y: calloutPose.cy - (phoneHeight / 2) * calloutPose.scale,
    width: phoneWidth * calloutPose.scale,
    height: phoneHeight * calloutPose.scale,
  };
  const pills = layoutPortraitPills(padded, canvas, phone);
  return names.map((name, index) => ({
    name,
    label: labels[name] ?? name,
    role: roles[index],
    slotY: pills[index].y,
    gutterX: 0,
    side: pills[index].side,
    exit: pills[index].exit,
    laneY: 0,
    enter: timing(name).enter,
    leave: timing(name).exit,
  }));
}

// --- boards pile-up ----------------------------------------------------------------

/** How many board phones rise together before the rest crowd in. */
export const SHOWCASE_NEAT_BOARDS = 3;

/** Local frames of the pile-up. The last arrival waits a beat, then squeezes in. */
export const SHOWCASE_PILEUP = {
  firstArrival: 40,
  arrivalGap: 6,
  squeezePause: 5,
  /** Nominal squeeze frame with every board present (for the stills). */
  squeeze: 40 + 3 * 6 + 6 + 5,
} as const;

/**
 * Local arrival frame for each phone in arrival order. The neat phones ride the
 * scene change (the persistent one is released with the background at L-4);
 * the rest come in fast, and the last one pauses before it squeezes in.
 */
export function pileupArrivalFrames(arrivalCount: number, neatCount: number, mainIndex: number): number[] {
  const frames: number[] = [];
  let neatSeen = 0;
  for (let index = 0; index < arrivalCount; index += 1) {
    if (index < neatCount) {
      frames.push(index === mainIndex ? -4 : neatSeen === 0 ? -2 : 3);
      if (index !== mainIndex) neatSeen += 1;
      continue;
    }
    const pileIndex = index - neatCount;
    const isLast = index === arrivalCount - 1 && pileIndex > 0;
    frames.push(
      SHOWCASE_PILEUP.firstArrival +
        pileIndex * SHOWCASE_PILEUP.arrivalGap +
        (isLast ? SHOWCASE_PILEUP.squeezePause : 0),
    );
  }
  return frames;
}

/** Local frames of the workouts checklist: ticks every 12 frames, a rest countdown after the top set. */
export const SHOWCASE_WORKOUT_BEATS = {
  rowsIn: 18,
  rowStagger: 4,
  firstTick: 28,
  tickGap: 10,
  /** Local frame the rest countdown starts: the frame the footage's rest pill reads 0:29. */
  restStart: 64,
  /** Two seconds of the countdown, one value a second. */
  restFrames: 60,
} as const;

/** Tick frame per row; the rest countdown runs after the hardest row and delays the rows after it. */
export function workoutTickFrames(
  grades: readonly string[],
  /** Local frame the footage's rest pill first shows a value, when there is footage. */
  restFromFootage?: number | null,
): {
  ticks: number[];
  restRow: number;
  restStart: number;
  restEnd: number;
} {
  const value = (grade: string) => Number.parseInt(grade.replace(/[^0-9]/g, ''), 10) || 0;
  const top = grades.reduce((best, grade, index) => (value(grade) > value(grades[best]) ? index : best), 0);
  const { firstTick, tickGap, restFrames } = SHOWCASE_WORKOUT_BEATS;
  const restStart = Math.max(firstTick + top * tickGap + 6, restFromFootage ?? SHOWCASE_WORKOUT_BEATS.restStart);
  const ticks = grades.map((_, index) => firstTick + index * tickGap + (index > top ? restFrames - tickGap + 6 : 0));
  return { ticks, restRow: Math.min(top + 1, grades.length - 1), restStart, restEnd: restStart + restFrames };
}

/**
 * Left-to-right order once the pile-up settles: the three neat phones keep the
 * middle, newcomers take the flanks, and the last arrival squeezes in beside
 * the persistent phone.
 */
export const SHOWCASE_BOARDS_FINAL_ORDER: readonly ShowcaseTakeId[] = [
  'boards-touchstone',
  'boards-woods',
  'boards-kilter',
  'boards-tension',
  'boards-soill',
  'boards-moonboard',
  'boards-decoy',
  'boards-grasshopper',
];

/**
 * The pile-up for whichever board takes have footage. The persistent phone is
 * Tension when it was recorded, else the first neat arrival.
 */
export function planBoards(
  arrivalOrder: readonly ShowcaseTakeId[],
  available: ReadonlySet<ShowcaseTakeId>,
): StageBoards {
  const arrival = arrivalOrder.filter((takeId) => available.has(takeId));
  if (arrival.length === 0) throw new Error('The boards scene needs at least one board take with footage');
  const final = SHOWCASE_BOARDS_FINAL_ORDER.filter((takeId) => arrival.includes(takeId));
  for (const takeId of arrival) if (!final.includes(takeId)) final.push(takeId);
  const neatCount = Math.min(SHOWCASE_NEAT_BOARDS, arrival.length);
  const main = arrival.slice(0, neatCount).includes('boards-tension') ? 'boards-tension' : arrival[0];
  const labels: Partial<Record<ShowcaseTakeId, string>> = {};
  for (const takeId of arrival) labels[takeId] = boardTakeLabel(takeId);
  const arrivalFrames = pileupArrivalFrames(arrival.length, neatCount, arrival.indexOf(main));
  return { arrival, final, main, neatCount, arrivalFrames, labels };
}

// --- stills ----------------------------------------------------------------------

export type StillFrame = Readonly<{ frame: number; label: string }>;

/**
 * Frames for one scene's contact sheet: its settled frame first, then the
 * entrance, the mid-transitions either side, and for the outro the loop seam.
 */
export function stillFramesForScene(
  scene: ShowcaseScene,
  totalFrames = SHOWCASE_TOTAL_FRAMES,
  /** Every callout: one still each, once its pill has landed. */
  callouts: ReadonlyArray<Readonly<{ name: string; enter: number; leave: number }>> = [],
): StillFrame[] {
  const length = scene.endFrame - scene.startFrame;
  const settled =
    scene.id === 'hook'
      ? 0
      : scene.id === 'outro'
        ? scene.startFrame + length - SHOWCASE_CHOREO.loopCloserFrames - 2
        : scene.endFrame - SHOWCASE_CHOREO.settleEndFromEnd - 2;
  const frames: StillFrame[] = [
    { frame: settled, label: 'settled' },
    { frame: scene.startFrame + 2, label: 'in +2' },
    { frame: scene.startFrame + 12, label: 'in +12' },
    { frame: scene.startFrame + 26, label: 'in +26' },
    { frame: scene.endFrame - 8, label: 'out -8' },
    { frame: Math.min(totalFrames - 1, scene.endFrame + 1), label: 'next +1' },
  ];
  if (scene.id === 'hook') frames.splice(1, 0, { frame: 24, label: 'spark' });
  if (scene.id === 'boards') {
    frames.splice(
      4,
      0,
      { frame: scene.startFrame + SHOWCASE_PILEUP.firstArrival + 8, label: 'crowding' },
      { frame: scene.startFrame + SHOWCASE_PILEUP.squeeze + 3, label: 'squeeze' },
    );
  }
  if (scene.id === 'workouts') {
    frames.splice(4, 0, { frame: scene.startFrame + SHOWCASE_WORKOUT_BEATS.restStart + 12, label: 'rest' });
  }
  if (scene.id === 'outro') {
    frames.splice(4, 2, { frame: totalFrames - 12, label: 'closer -12' }, { frame: totalFrames - 1, label: 'last' });
    frames.push({ frame: 0, label: 'frame 0' });
  }
  for (const callout of callouts) {
    const local = Math.min(callout.enter + 24, callout.leave - 7);
    frames.push({ frame: scene.startFrame + local, label: callout.name });
  }
  const unique = new Map<number, StillFrame>();
  for (const still of frames) if (!unique.has(still.frame)) unique.set(still.frame, still);
  return [...unique.values()];
}

// --- encoding ------------------------------------------------------------------------

/**
 * Hard gate per web file, under `scripts/check-large-files.mjs`'s 2 MB so the
 * shipped files need no allowlist entry.
 */
export const SHOWCASE_WEB_MAX_BYTES = 1_900_000;

/**
 * The frame the web cut starts on and its poster (`showcase-hero-9x16.webp`)
 * shows: the light scene settled, "Swipe, and the wall follows." over the lit
 * phone with both callouts up. The web encodes play the loop rotated to start
 * here (`webRotation`); `brag.mp4` and `brag.jpg` keep frame 0, the hook, for
 * social. `--poster-frame` overrides it.
 */
export const SHOWCASE_WEB_POSTER_FRAME = 142;

/**
 * The lighter 9:16 encode for phones: 720x1280, a bitrate that lands each file
 * under its cap for the cut's length (`webBitrateFor`).
 */
export const SHOWCASE_WEB_LITE = {
  size: { width: 720, height: 1280 },
  maxWebmBytes: 1_750_000,
  maxMp4Bytes: 1_900_000,
} as const;

/** Video bitrate (kbit/s) that lands a `seconds`-long encode under `maxBytes`, keeping `headroom` spare. */
export function webBitrateFor(maxBytes: number, seconds: number, headroom = 0.12): number {
  return Math.floor((maxBytes * 8 * (1 - headroom)) / seconds / 1000);
}

/**
 * True when a frame is a flat fill: the standard deviation of its luma (0–255,
 * any sampling) is under `threshold`. The renderer checks every frame at 48 px
 * wide and fails the render on one.
 */
export function isFlatFrame(luma: ArrayLike<number>, threshold = 3): boolean {
  if (luma.length === 0) return true;
  let sum = 0;
  for (let index = 0; index < luma.length; index += 1) sum += luma[index];
  const mean = sum / luma.length;
  let variance = 0;
  for (let index = 0; index < luma.length; index += 1) variance += (luma[index] - mean) ** 2;
  return Math.sqrt(variance / luma.length) < threshold;
}
export const SHOWCASE_MASTER_CRF = 18;

/** The web cut plays every frame of the loop, rotated to start on the poster frame. */
export const webCutSeconds = (totalFrames = SHOWCASE_TOTAL_FRAMES): number => totalFrames / SHOWCASE_FPS;

/**
 * The web cut's filter graph: frames `start..end` then `0..start-1`, so it opens
 * on its poster. The loop is seamless (the closer leads back into frame 0), so
 * the rotated loop is too; the new seam falls mid-scene between two
 * consecutive frames.
 */
export function webRotation(start: number, size?: Readonly<{ width: number; height: number }>): string[] {
  if (start <= 0) return ['-vf', toBt709(size)];
  return [
    '-filter_complex',
    `[0:v]split[head][tail];[head]trim=start_frame=${start},setpts=PTS-STARTPTS[a];` +
      `[tail]trim=end_frame=${start},setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0,${toBt709(size)}[out]`,
    '-map',
    '[out]',
  ];
}

const BT709 = [
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-color_range',
  'tv',
] as const;

/** RGB → BT.709 limited-range 4:2:0, so the tags describe the pixels. */
const toBt709 = (size?: Readonly<{ width: number; height: number }>): string =>
  [
    size ? `scale=${size.width}:${size.height}:flags=lanczos` : null,
    'scale=out_color_matrix=bt709:out_range=tv',
    'format=yuv420p',
  ]
    .filter(Boolean)
    .join(',');

/**
 * 2x PNG screenshots on stdin → 1x RGB mezzanine, lanczos downscale. Every
 * other encode reads the mezzanine, so the browser runs once.
 *
 * Near-lossless H.264 in RGB rather than FFV1: the static grain makes every
 * lossless codec pay ~0.9 MB a frame (600 MB for the 16:9 cut), where crf 6
 * lands around a sixth of that with no difference a crf 18 master can show.
 */
export const SHOWCASE_MEZZANINE_CRF = 6;

export function buildMezzanineArgs(format: ShowcaseFormat, output: string): string[] {
  const { width, height } = SHOWCASE_CANVAS[format];
  return [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'image2pipe',
    '-framerate',
    String(SHOWCASE_FPS),
    '-c:v',
    'png',
    '-i',
    '-',
    '-vf',
    `scale=${width}:${height}:flags=lanczos`,
    '-c:v',
    'libx264rgb',
    '-crf',
    String(SHOWCASE_MEZZANINE_CRF),
    '-preset',
    'fast',
    '-pix_fmt',
    'rgb24',
    output,
  ];
}

/** `out/brag.mp4`: frame 0 is the settled poster, no audio (the soundtrack is muxed later). */
export function buildMasterArgs(input: string, output: string): string[] {
  return [
    '-y',
    '-loglevel',
    'error',
    '-i',
    input,
    '-an',
    '-vf',
    toBt709(),
    '-c:v',
    'libx264',
    '-crf',
    String(SHOWCASE_MASTER_CRF),
    '-preset',
    'slow',
    '-tune',
    'animation',
    '-pix_fmt',
    'yuv420p',
    ...BT709,
    '-movflags',
    '+faststart',
    output,
  ];
}

export type WebEncode = Readonly<{
  input: string;
  output: string;
  bitrateKbps: number;
  passLog: string;
  /** The frame the rotated loop starts on (the poster frame). */
  startFrame: number;
  size?: Readonly<{ width: number; height: number }>;
}>;

/** VP9 two-pass at a target bitrate. Pass 1 writes only the log. */
export function buildWebmPassArgs(
  { input, output, bitrateKbps, passLog, size, startFrame }: WebEncode,
  pass: 1 | 2,
): string[] {
  return [
    '-y',
    '-loglevel',
    'error',
    '-i',
    input,
    '-an',
    ...webRotation(startFrame, size),
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    `${bitrateKbps}k`,
    '-maxrate',
    `${Math.round(bitrateKbps * 1.6)}k`,
    '-minrate',
    `${Math.round(bitrateKbps * 0.3)}k`,
    '-row-mt',
    '1',
    '-tile-columns',
    '2',
    '-deadline',
    'good',
    '-cpu-used',
    pass === 1 ? '4' : '1',
    '-auto-alt-ref',
    '1',
    '-lag-in-frames',
    '25',
    '-g',
    '240',
    '-pix_fmt',
    'yuv420p',
    ...BT709,
    '-pass',
    String(pass),
    '-passlogfile',
    passLog,
    ...(pass === 1 ? ['-f', 'null', '/dev/null'] : [output]),
  ];
}

/** H.264 two-pass at a target bitrate, `+faststart` so it plays while loading. */
export function buildWebMp4PassArgs(
  { input, output, bitrateKbps, passLog, size, startFrame }: WebEncode,
  pass: 1 | 2,
): string[] {
  return [
    '-y',
    '-loglevel',
    'error',
    '-i',
    input,
    '-an',
    ...webRotation(startFrame, size),
    '-c:v',
    'libx264',
    '-preset',
    'slower',
    '-tune',
    'animation',
    '-profile:v',
    'high',
    '-b:v',
    `${bitrateKbps}k`,
    '-maxrate',
    `${Math.round(bitrateKbps * 1.8)}k`,
    '-bufsize',
    `${bitrateKbps * 4}k`,
    '-g',
    '240',
    '-pix_fmt',
    'yuv420p',
    ...BT709,
    '-pass',
    String(pass),
    '-passlogfile',
    `${passLog}-x264`,
    ...(pass === 1 ? ['-f', 'null', '/dev/null'] : ['-movflags', '+faststart', output]),
  ];
}

/** One mezzanine frame as PNG on stdout, for Sharp (posters and `brag.jpg`). */
export function buildFramePngArgs(input: string, frame: number): string[] {
  return [
    '-loglevel',
    'error',
    '-i',
    input,
    '-vf',
    `select=eq(n\\,${frame})`,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-c:v',
    'png',
    '-',
  ];
}

export function buildDurationProbeArgs(file: string): string[] {
  return [
    '-v',
    'error',
    '-count_frames',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=nb_read_frames,width,height:format=duration',
    '-of',
    'default=noprint_wrappers=1',
    file,
  ];
}

// --- placeholder footage ------------------------------------------------------------

/** The committed App Store screenshots, beside the showcase posters under public/images. */
export const SHOWCASE_STORE_STILL_DIR = resolve(SHOWCASE_WEB_POSTER_DIR, '../app/ios');

/** iPhone 16 Pro Max in points; every committed clip and store still is 1320x2868 scaled to 736x1600. */
export const PLACEHOLDER_SCREEN = { width: 440, height: 956 } as const;

export type PlaceholderSource =
  | Readonly<{ kind: 'video'; file: string; seek: number }>
  /** One frame of a help clip, held for the whole take. */
  | Readonly<{ kind: 'frame'; file: string; at: number }>
  | Readonly<{ kind: 'still'; file: string }>
  | Readonly<{ kind: 'render'; board: PlaceholderBoardRender }>
  /**
   * The drawn Dynamic Island, placeholder-only: the board's two most popular
   * climbs as rendered screens, each under an expanded island showing that
   * climb, switching (the "Next" tap) `nextAt` seconds into the take.
   */
  | Readonly<{ kind: 'island'; board: PlaceholderBoardRender; nextAt: number; queue: IslandQueue }>;

/**
 * A board phone with no committed recording: a real climb on that board, drawn
 * by the backend's public board renderer (`GET /render/board`, the image the
 * climb page and the apps use), laid into an app-like screen. The climb is the
 * most popular one on the board's default preview config (the one the backend
 * warms at boot), fetched from the public GraphQL `searchClimbs`.
 */
export type PlaceholderBoardRender = Readonly<{
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: readonly number[];
  angle: number;
}>;

export const SHOWCASE_BOARDSESH_API = 'https://ws.boardsesh.com';

/** The `searchClimbs` request for a board's most popular climbs. */
export function buildClimbSearchRequest(board: PlaceholderBoardRender): { url: string; body: string } {
  const query =
    'query($i: ClimbSearchInput!){ searchClimbs(input:$i){ climbs { uuid name difficulty frames setter_username } } }';
  const input = {
    boardName: board.boardName,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds.join(','),
    angle: board.angle,
    pageSize: 20,
    sortBy: 'popular',
  };
  return { url: `${SHOWCASE_BOARDSESH_API}/graphql`, body: JSON.stringify({ query, variables: { i: input } }) };
}

export type PlaceholderClimb = Readonly<{ name: string; grade: string; setter: string; frames: string }>;

/**
 * The climb to show: the most popular one with a grade and a name that fits
 * the header. `difficulty` reads like `6a/V3`; the screen shows the V grade.
 */
export function pickPlaceholderClimbs(
  climbs: ReadonlyArray<Readonly<{ name: string; difficulty: string; frames: string; setter_username: string }>>,
  count: number,
): PlaceholderClimb[] {
  const picked: PlaceholderClimb[] = [];
  for (const climb of climbs) {
    const name = climb.name.trim();
    const grade = climb.difficulty
      .split('/')
      .find((part) => /^V\d/.test(part.trim()))
      ?.trim();
    if (!grade || !name || name.length > 18 || !climb.frames) continue;
    picked.push({ name, grade, setter: climb.setter_username, frames: climb.frames });
    if (picked.length === count) break;
  }
  return picked;
}

export const pickPlaceholderClimb = (climbs: Parameters<typeof pickPlaceholderClimbs>[0]): PlaceholderClimb | null =>
  pickPlaceholderClimbs(climbs, 1)[0] ?? null;

/** The public board image for a climb: Aura drawing on the app's dark play field. */
export function buildBoardRenderUrl(board: PlaceholderBoardRender, frames: string): string {
  const params = new URLSearchParams({
    board_name: board.boardName,
    layout_id: String(board.layoutId),
    size_id: String(board.sizeId),
    set_ids: board.setIds.join(','),
    frames,
    format: 'png',
    include_background: '1',
    color_scheme: 'dark',
    render_mode: 'aura',
    field_color: '#181225',
  });
  return `${SHOWCASE_BOARDSESH_API}/render/board?${params.toString()}`;
}

/**
 * The app-like screen a board render sits in, at the store-screenshot size:
 * a status bar, the climb's name, grade and setter as the play view shows them,
 * and the board fitted below. Returns the SVG for everything but the board and
 * where the board goes.
 */
export function renderedBoardScreen(
  climb: PlaceholderClimb,
  boardSize: Readonly<{ width: number; height: number }>,
): { svg: string; board: { left: number; top: number; width: number; height: number } } {
  const { width, height } = PLACEHOLDER_CARD_SIZE;
  const maxWidth = width - 40;
  const maxHeight = 1060;
  const scale = Math.min(maxWidth / boardSize.width, maxHeight / boardSize.height);
  const boardWidth = Math.round(boardSize.width * scale);
  const boardHeight = Math.round(boardSize.height * scale);
  const board = { left: Math.round((width - boardWidth) / 2), top: 330, width: boardWidth, height: boardHeight };
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">` +
    `<rect width="100%" height="100%" fill="#0B0910"/>` +
    `<text x="96" y="92" font-size="30" font-weight="700" fill="#FFFFFF">09:41</text>` +
    `<rect x="258" y="56" width="220" height="62" rx="31" fill="#000000"/>` +
    `<rect x="338" y="150" width="60" height="8" rx="4" fill="#FFFFFF" fill-opacity="0.25"/>` +
    `<text x="${width / 2}" y="238" font-size="38" font-weight="700" text-anchor="middle" fill="#FFFFFF">${escapeXml(climb.name)}</text>` +
    `<text x="${width / 2}" y="282" font-size="25" text-anchor="middle" fill="#FFFFFF" fill-opacity="0.55">${escapeXml(climb.setter)}</text>` +
    `<text x="${width - 36}" y="238" font-size="38" font-weight="800" text-anchor="end" fill="#FF5026">${escapeXml(climb.grade)}</text>` +
    `<rect x="24" y="1484" width="${width - 48}" height="72" rx="24" fill="#FFFFFF" fill-opacity="0.08"/>` +
    `<text x="56" y="1530" font-size="26" font-weight="600" fill="#FFFFFF">Logbook</text>` +
    `</svg>`;
  return { svg, board };
}

export type PlaceholderTake = Readonly<{
  source: PlaceholderSource;
  anchors: Partial<Record<ShowcaseCalloutName, ShowcaseAnchorRect>>;
}>;

/** A board config with plenty of popular climbs (the backend's boot-warmed preview config, bar Decoy). */
const boardRender = (boardName: string, layoutId: number, sizeId: number, setIds: number[]): PlaceholderSource => ({
  kind: 'render',
  board: { boardName, layoutId, sizeId, setIds, angle: 40 },
});

/**
 * Where the drawn island placeholder puts the expanded Live Activity's
 * controls, in points, following `ClimbSessionLiveActivity.swift`: leading
 * board thumbnail (48x60), centre climb name over "N of M · angle", trailing
 * grade numeral, and a bottom row of Prev, the bulb (ReconnectBoardIntent),
 * mirror (MirrorClimbIntent) and Next.
 */
export const ISLAND_LAYOUT = {
  island: { x: 10, y: 10, width: 420, height: 196, radius: 48 },
  thumbnail: { x: 30, y: 50, width: 48, height: 60, radius: 10 },
  prev: { x: 30, y: 140, width: 114, height: 44 },
  bulb: { x: 148, y: 140, width: 44, height: 44 },
  mirror: { x: 196, y: 142, width: 40, height: 40 },
  next: { x: 240, y: 140, width: 170, height: 44 },
} as const;

const ISLAND_BUTTONS = {
  'lock-relight': ISLAND_LAYOUT.bulb,
  'lock-mirror': ISLAND_LAYOUT.mirror,
  'lock-next': ISLAND_LAYOUT.next,
} as const satisfies Record<string, ShowcaseAnchorRect>;

/** Queue position and angle the island's metadata line shows: "3 of 12 · 40°". */
export type IslandQueue = Readonly<{ index: number; total: number; angle: number }>;

/**
 * The drawn Dynamic Island for the placeholder take, over a screen of the same
 * climb: the expanded island's SVG (without the thumbnail image, which the
 * renderer composites at `thumbnail`), marked as a placeholder under it.
 * Placeholder-only: the final cut shows the recorder's footage of the real
 * Live Activity or drops the scene.
 */
export function islandOverlaySvg(
  climb: PlaceholderClimb,
  queue: IslandQueue,
  gradeColor: string,
): { svg: string; thumbnail: { left: number; top: number; width: number; height: number } } {
  const { width, height } = PLACEHOLDER_CARD_SIZE;
  const scale = width / PLACEHOLDER_SCREEN.width;
  const px = (value: number) => (value * scale).toFixed(1);
  const { island, thumbnail, prev, bulb, mirror, next } = ISLAND_LAYOUT;
  const violet = '#A78BFA';
  const bulbX = bulb.x + bulb.width / 2;
  const bulbY = bulb.y + bulb.height / 2;
  const mirrorX = mirror.x + mirror.width / 2;
  const mirrorY = mirror.y + mirror.height / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Helvetica, Arial, sans-serif">` +
    `<rect x="${px(island.x)}" y="${px(island.y)}" width="${px(island.width)}" height="${px(island.height)}" rx="${px(island.radius)}" fill="#000000"/>` +
    `<rect x="${px(thumbnail.x)}" y="${px(thumbnail.y)}" width="${px(thumbnail.width)}" height="${px(thumbnail.height)}" rx="${px(thumbnail.radius)}" fill="#1A1424"/>` +
    `<text x="${px(92)}" y="${px(76)}" font-size="${px(17)}" font-weight="700" fill="#F5F2FB">${escapeXml(climb.name)}</text>` +
    `<text x="${px(92)}" y="${px(100)}" font-size="${px(15)}" fill="#A9A2B6">${queue.index} of ${queue.total} · ${queue.angle}°</text>` +
    `<text x="${px(410)}" y="${px(86)}" font-size="${px(24)}" font-weight="800" text-anchor="end" fill="${gradeColor}">${escapeXml(climb.grade)}</text>` +
    `<text x="${px(prev.x + prev.width / 2)}" y="${px(prev.y + 27)}" font-size="${px(15)}" font-weight="600" text-anchor="middle" fill="${violet}">‹ Prev</text>` +
    // The lit bulb: amber glyph with its soft glow, the only warm accent.
    `<circle cx="${px(bulbX)}" cy="${px(bulbY - 3)}" r="${px(12)}" fill="#FBBF24" fill-opacity="0.25"/>` +
    `<circle cx="${px(bulbX)}" cy="${px(bulbY - 3)}" r="${px(7)}" fill="#FBBF24"/>` +
    `<rect x="${px(bulbX - 4)}" y="${px(bulbY + 5)}" width="${px(8)}" height="${px(5)}" rx="${px(1.5)}" fill="#FBBF24"/>` +
    // Mirror: two arrows round a circle.
    `<path d="M ${px(mirrorX - 9)} ${px(mirrorY - 2)} A ${px(9)} ${px(9)} 0 0 1 ${px(mirrorX + 8)} ${px(mirrorY - 5)}" fill="none" stroke="#F5F2FB" stroke-width="${px(2.4)}" stroke-linecap="round"/>` +
    `<path d="M ${px(mirrorX + 9)} ${px(mirrorY + 2)} A ${px(9)} ${px(9)} 0 0 1 ${px(mirrorX - 8)} ${px(mirrorY + 5)}" fill="none" stroke="#F5F2FB" stroke-width="${px(2.4)}" stroke-linecap="round"/>` +
    `<path d="M ${px(mirrorX + 4)} ${px(mirrorY - 9)} L ${px(mirrorX + 9)} ${px(mirrorY - 5)} L ${px(mirrorX + 4)} ${px(mirrorY - 1)}" fill="none" stroke="#F5F2FB" stroke-width="${px(2.4)}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M ${px(mirrorX - 4)} ${px(mirrorY + 9)} L ${px(mirrorX - 9)} ${px(mirrorY + 5)} L ${px(mirrorX - 4)} ${px(mirrorY + 1)}" fill="none" stroke="#F5F2FB" stroke-width="${px(2.4)}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<text x="${px(next.x + next.width / 2)}" y="${px(next.y + 27)}" font-size="${px(15)}" font-weight="600" text-anchor="middle" fill="${violet}">Next ›</text>` +
    `<rect x="${px(120)}" y="${px(214)}" width="${px(200)}" height="${px(22)}" rx="${px(11)}" fill="#FF8A3D"/>` +
    `<text x="${px(220)}" y="${px(229)}" font-size="${px(12)}" font-weight="700" text-anchor="middle" fill="#16111F">PLACEHOLDER ISLAND</text>` +
    `</svg>`;
  const box = (value: number) => Math.round(value * scale);
  return {
    svg,
    thumbnail: {
      left: box(thumbnail.x),
      top: box(thumbnail.y),
      width: box(thumbnail.width),
      height: box(thumbnail.height),
    },
  };
}

/**
 * Takes whose placeholder is drawn rather than recorded or rendered. Their
 * footage directory gets this marker, and a render without
 * `--placeholder-footage` treats such a take as missing, so the final cut never
 * shows a drawn island.
 */
export const SHOWCASE_DRAWN_PLACEHOLDER_MARKER = 'DRAWN-PLACEHOLDER';

/**
 * Stand-in footage until the recorder lands real takes: committed help clips
 * (real app recordings), store screenshots, real board renders for the boards
 * with neither, and (placeholder-only) a drawn Dynamic Island. Anchor rects are hand-measured on those sources in
 * points.
 * Where the source has no such control (`invite-qr` on the queue still, the
 * activity calendar on the profile still) the anchor borrows a nearby element
 * so the callout layout can still be judged.
 */
export const SHOWCASE_PLACEHOLDER_TAKES: Record<ShowcaseTakeId, PlaceholderTake> = {
  light: {
    source: { kind: 'video', file: 'preview-browsing.mp4', seek: 0.2 },
    anchors: {
      'wall-pill': { x: 16, y: 133, width: 33, height: 32 },
      'board-surface': { x: 21, y: 188, width: 398, height: 560 },
    },
  },
  'boards-kilter': { source: { kind: 'still', file: 'kilter.webp' }, anchors: {} },
  'boards-tension': { source: { kind: 'still', file: 'tension.webp' }, anchors: {} },
  'boards-moonboard': { source: { kind: 'still', file: 'moonboard.webp' }, anchors: {} },
  'boards-woods': { source: boardRender('woods', 1, 2, [1]), anchors: {} },
  // Decoy's full-size layout draws only with its whole hold-set list (2–20).
  'boards-decoy': {
    source: boardRender(
      'decoy',
      2,
      1,
      Array.from({ length: 19 }, (_, index) => index + 2),
    ),
    anchors: {},
  },
  'boards-touchstone': { source: boardRender('touchstone', 1, 1, [1]), anchors: {} },
  'boards-grasshopper': { source: boardRender('grasshopper', 1, 4, [1, 2]), anchors: {} },
  'boards-soill': { source: boardRender('soill', 1, 1, [1]), anchors: {} },
  wall: {
    source: { kind: 'still', file: 'wall-status.webp' },
    anchors: {
      'board-history-button': { x: 371, y: 73, width: 51, height: 51 },
      'now-on-wall': { x: 132, y: 81, width: 230, height: 35 },
      'wall-history': { x: 8, y: 181, width: 424, height: 24 },
    },
  },
  crew: {
    source: { kind: 'still', file: 'queue.webp' },
    anchors: {
      'invite-qr': { x: 26, y: 175, width: 46, height: 46 },
      'queue-row-avatar': { x: 397, y: 282, width: 22, height: 22 },
      'play-next': { x: 18, y: 359, width: 412, height: 102 },
    },
  },
  workouts: {
    source: { kind: 'frame', file: 'start-playlist-queue.mp4', at: 1.5 },
    anchors: {
      'workout-type': { x: 16, y: 187, width: 103, height: 47 },
      'rest-timer': { x: 22, y: 817, width: 396, height: 48 },
    },
  },
  'lock-screen': {
    // Next is tapped 3.2 s in: scene frame 66, once the callouts are up.
    source: {
      kind: 'island',
      board: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 20], angle: 40 },
      nextAt: 3.2,
      queue: { index: 3, total: 12, angle: 40 },
    },
    anchors: { ...ISLAND_BUTTONS },
  },
  log: {
    source: { kind: 'still', file: 'profile-overview.webp' },
    anchors: {
      'profile-board-filter': { x: 16, y: 290, width: 124, height: 20 },
      'activity-calendar': { x: 18, y: 686, width: 405, height: 150 },
    },
  },
};

/** Generated placeholder screens are drawn at the store-screenshot size, 736x1600. */
export const PLACEHOLDER_CARD_SIZE = { width: 736, height: 1600 } as const;

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * ffmpeg for one placeholder take. `screens` are the rasterised screens for a
 * `render` source (one) or an `island` source (the climb before and after the
 * Next tap); the renderer draws them with Sharp first.
 */
export function buildPlaceholderFootageArgs(
  takeId: ShowcaseTakeId,
  take: PlaceholderTake,
  outDir: string,
  screens: readonly string[] = [],
): string[] {
  const seconds = requiredTakeSeconds(takeId);
  const frames = String(Math.ceil(seconds * SHOWCASE_FPS));
  const { source } = take;
  if (source.kind === 'island') {
    if (screens.length !== 2) throw new Error(`Take "${takeId}" needs its two island screens drawn first`);
    const before = source.nextAt.toFixed(3);
    const after = (seconds - source.nextAt + 1).toFixed(3);
    return [
      '-y',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-t',
      before,
      '-i',
      screens[0],
      '-loop',
      '1',
      '-t',
      after,
      '-i',
      screens[1],
      '-filter_complex',
      `[0:v]fps=${SHOWCASE_FPS},setsar=1[a];[1:v]fps=${SHOWCASE_FPS},setsar=1[b];[a][b]concat=n=2:v=1,scale=${SHOWCASE_FOOTAGE_WIDTH}:-2:flags=lanczos`,
      '-frames:v',
      frames,
      '-q:v',
      '3',
      resolve(outDir, '%05d.jpg'),
    ];
  }
  let input: string[];
  let hold = '';
  if (source.kind === 'video') input = ['-ss', String(source.seek), '-i', resolve(HELP_CLIP_VIDEO_DIR, source.file)];
  else if (source.kind === 'frame') {
    input = ['-ss', String(source.at), '-i', resolve(HELP_CLIP_VIDEO_DIR, source.file)];
    // Keep only the first frame and repeat it.
    hold = 'trim=end_frame=1,loop=loop=-1:size=1:start=0,setpts=N/30/TB,';
  } else if (source.kind === 'still') input = ['-loop', '1', '-i', resolve(SHOWCASE_STORE_STILL_DIR, source.file)];
  else {
    if (!screens[0]) throw new Error(`Take "${takeId}" is a generated placeholder; rasterise it first`);
    input = ['-loop', '1', '-i', screens[0]];
  }
  return [
    '-y',
    '-loglevel',
    'error',
    ...input,
    // A clip shorter than the take holds its last frame.
    '-vf',
    `${hold}fps=${SHOWCASE_FPS},scale=${SHOWCASE_FOOTAGE_WIDTH}:-2:flags=lanczos,tpad=stop_mode=clone:stop_duration=${Math.ceil(seconds)}`,
    '-frames:v',
    frames,
    '-q:v',
    '3',
    resolve(outDir, '%05d.jpg'),
  ];
}

export function placeholderAnchorsFile(takeId: ShowcaseTakeId, take: PlaceholderTake): ShowcaseAnchorsFile {
  const anchors: Partial<Record<ShowcaseCalloutName, ShowcaseAnchorSample[]>> = {};
  for (const [name, rect] of Object.entries(take.anchors) as [ShowcaseCalloutName, ShowcaseAnchorRect][]) {
    anchors[name] = [{ t: 0, ...rect }];
  }
  return { takeId, screen: PLACEHOLDER_SCREEN, anchors };
}

// --- CLI ------------------------------------------------------------------------------

export type RenderArgs = Readonly<{
  stills: boolean;
  /** Frame for the web posters (`SHOWCASE_WEB_POSTER_FRAME` unless `--poster-frame`). */
  posterFrame: number;
  /** One frame as a full-size PNG, for a close look (`--frame <n>`). */
  frame: number | null;
  measure: boolean;
  fromFrame: number;
  formats: readonly ShowcaseFormat[];
  placeholderFootage: boolean;
  skipWeb: boolean;
  /**
   * The outro's donation line (default on). `--no-donation-line` renders the
   * cut for a store preview or an install ad, and skips the web encodes so the
   * homepage files keep the line.
   */
  donationLine: boolean;
  help: boolean;
}>;

function parseFrameNumber(flag: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= SHOWCASE_TOTAL_FRAMES || String(parsed) !== value) {
    throw new Error(`${flag} must be an integer in 0..${SHOWCASE_TOTAL_FRAMES - 1}`);
  }
  return parsed;
}

export function parseRenderArgs(argv: readonly string[]): RenderArgs {
  let stills = false;
  let posterFrame: number = SHOWCASE_WEB_POSTER_FRAME;
  let frame: number | null = null;
  let measure = false;
  let fromFrame = 0;
  let formats: ShowcaseFormat[] = [...SHOWCASE_FORMATS];
  let placeholderFootage = false;
  let skipWeb = false;
  let donationLine = true;
  const result = (help: boolean): RenderArgs => ({
    stills,
    posterFrame,
    frame,
    measure,
    fromFrame,
    formats,
    placeholderFootage,
    skipWeb: skipWeb || !donationLine,
    donationLine,
    help,
  });
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--help' || argument === '-h') return result(true);
    if (argument === '--stills') stills = true;
    else if (argument === '--measure') measure = true;
    else if (argument === '--placeholder-footage') placeholderFootage = true;
    else if (argument === '--skip-web') skipWeb = true;
    else if (argument === '--no-donation-line') donationLine = false;
    else if (
      argument === '--from-frame' ||
      argument === '--format' ||
      argument === '--frame' ||
      argument === '--poster-frame'
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value`);
      index += 1;
      if (argument === '--from-frame') fromFrame = parseFrameNumber(argument, value);
      else if (argument === '--frame') frame = parseFrameNumber(argument, value);
      else if (argument === '--poster-frame') posterFrame = parseFrameNumber(argument, value);
      else {
        if (!(SHOWCASE_FORMATS as readonly string[]).includes(value)) {
          throw new Error(`--format must be one of ${SHOWCASE_FORMATS.join(', ')}`);
        }
        formats = [value as ShowcaseFormat];
      }
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return result(false);
}
