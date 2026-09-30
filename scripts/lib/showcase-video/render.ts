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
  type ShowcaseAnchorName,
  type ShowcaseAnchorRect,
  type ShowcaseAnchorSample,
  type ShowcaseAnchorsFile,
  type ShowcaseTakeId,
} from './contract';
import { HELP_CLIP_VIDEO_DIR } from '../help-clips';
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
  master: string;
  masterStill: string;
  shareCopy: string;
  webWebm: string;
  webMp4: string;
  poster: string;
  passLog: string;
}>;

export function showcaseOutputs(format: ShowcaseFormat): ShowcaseOutputs {
  const suffix = format === '16x9' ? '' : `-${format}`;
  return {
    mezzanine: resolve(SHOWCASE_FRAMES_DIR, `showcase${suffix}.mkv`),
    master: resolve(SHOWCASE_OUT_DIR, `brag${suffix}.mp4`),
    masterStill: resolve(SHOWCASE_OUT_DIR, `brag${suffix}.jpg`),
    shareCopy: resolve(SHOWCASE_OUT_DIR, 'share-copy.txt'),
    webWebm: resolve(SHOWCASE_WEB_VIDEO_DIR, `showcase${suffix}.webm`),
    webMp4: resolve(SHOWCASE_WEB_VIDEO_DIR, `showcase${suffix}.mp4`),
    poster: resolve(SHOWCASE_WEB_POSTER_DIR, `showcase-poster${suffix}.webp`),
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
  | 'OFF_BOTTOM';

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
  },
  '9x16': {
    OFF_RIGHT: pose(1560, 1300, 1.22, 4, -28, 6),
    // Body ~1100 px tall, centred low.
    CALLOUT: pose(540, 1230, 1.22),
    HERO_TILT: pose(640, 1400, 1.02, 4, 14, -2),
    BOARDS_MID: pose(540, 1250, 0.95),
    BOARDS_LEFT: pose(300, 1330, 0.82, 0, 0, -9),
    BOARDS_RIGHT: pose(780, 1330, 0.82, 0, 0, 9),
    OFF_BOTTOM: pose(540, 2700, 0.95),
  },
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

// --- footage timing ------------------------------------------------------

/**
 * Takes run one second ahead of their scene (the phone arrives before the
 * text), so footage frame 0 lines up with `scene.startFrame - 30`.
 */
export const SHOWCASE_TAKE_LEAD_FRAMES = SHOWCASE_FPS;

export function footageFrameIndex(scene: ShowcaseScene, frame: number, frameCount: number): number {
  const index = frame - scene.startFrame + SHOWCASE_TAKE_LEAD_FRAMES;
  return Math.max(0, Math.min(frameCount - 1, index));
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
  calloutStagger: 8,
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

/** Words a viewer has to read: runs of letters or digits, so "&" and "·" are free. */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? []).length;
}

export type ShowcaseRow = Readonly<{ name: string; grade: string; time: string }>;
export type ShowcaseCopy = Readonly<{
  hook: Readonly<{ headline: string }>;
  light: Readonly<{ headline: string; callouts: Partial<Record<ShowcaseAnchorName, string>> }>;
  boards: Readonly<{ headline: string; labels: readonly string[] }>;
  crew: Readonly<{ headline: string; callouts: Partial<Record<ShowcaseAnchorName, string>> }>;
  log: Readonly<{ headline: string; rows: readonly ShowcaseRow[] }>;
  outro: Readonly<{ wordmark: string; tagline: string; pill: string }>;
}>;

/** The text on screen once a scene has settled, by scene. */
export function sceneVisibleText(
  scene: ShowcaseScene,
  copy: ShowcaseCopy,
  callouts: readonly ShowcaseAnchorName[] = scene.callouts,
): string[] {
  switch (scene.id) {
    case 'hook':
      return [copy.hook.headline];
    case 'light':
      return [copy.light.headline, ...callouts.map((name) => copy.light.callouts[name] ?? '')];
    case 'boards':
      return [copy.boards.headline, ...copy.boards.labels];
    case 'crew':
      return [copy.crew.headline, ...callouts.map((name) => copy.crew.callouts[name] ?? '')];
    case 'log':
      // Grade chips and timestamps are glanced at, not read.
      return [copy.log.headline, ...copy.log.rows.map((row) => row.name)];
    case 'outro':
      return [copy.outro.wordmark, copy.outro.tagline, copy.outro.pill];
  }
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

export type ReadingBudgetReport = Readonly<{
  sceneId: ShowcaseScene['id'];
  words: number;
  needFrames: number;
  haveFrames: number;
}>;

export function readingBudgetReport(
  copy: ShowcaseCopy,
  scenes: readonly ShowcaseScene[] = SHOWCASE_SCENES,
): ReadingBudgetReport[] {
  return scenes.map((scene) => {
    const words = sceneVisibleText(scene, copy)
      .map((text) => countWords(text.replace(/\*/g, '')))
      .reduce((sum, count) => sum + count, 0);
    return {
      sceneId: scene.id,
      words,
      needFrames: readingBudgetFrames(words),
      haveFrames: readingWindowFrames(scene),
    };
  });
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

export const SHOWCASE_CALLOUT_LAYOUT = {
  boxPadding: 8,
  gutterX: 1340,
  /** Spacing between leader verticals when two would otherwise share the gutter. */
  gutterPitch: 18,
  pillX: 1400,
  pillHeight: 60,
  /** 9:16: pills sit this far in from the canvas edge. */
  portraitPillInset: 22,
  portraitPillWidth: 250,
  portraitMinGap: 76,
} as const;

export function calloutSlots(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [540];
  if (count === 2) return [420, 660];
  return [360, 540, 720].slice(0, count);
}

type Segment = Readonly<{ x1: number; y1: number; x2: number; y2: number }>;

function leaderSegments(start: CanvasPoint, gutterX: number, slotY: number, pillX: number): Segment[] {
  return [
    { x1: start.x, y1: start.y, x2: gutterX, y2: start.y },
    { x1: gutterX, y1: start.y, x2: gutterX, y2: slotY },
    { x1: gutterX, y1: slotY, x2: pillX, y2: slotY },
  ];
}

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

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

/**
 * One gutter x per leader so no two leaders cross or run on top of each other.
 * Leaders leave their box's right edge, run to their gutter, drop to their pill
 * slot and run into the pill. With at most three callouts, trying every order of
 * the gutter offsets is cheap and exact.
 */
export function assignLeaderGutters(
  starts: readonly CanvasPoint[],
  slots: readonly number[],
  layout: Readonly<{ gutterX: number; gutterPitch: number; pillX: number }> = SHOWCASE_CALLOUT_LAYOUT,
): number[] {
  const offsets = starts.map((_, index) => layout.gutterX - index * layout.gutterPitch);
  let best = offsets;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of permutations(offsets)) {
    const paths = starts.map((start, index) => leaderSegments(start, candidate[index], slots[index], layout.pillX));
    let crossings = 0;
    for (let first = 0; first < paths.length; first += 1) {
      for (let second = first + 1; second < paths.length; second += 1) {
        for (const a of paths[first]) for (const b of paths[second]) if (segmentsCross(a, b)) crossings += 1;
      }
    }
    // Prefer fewer crossings, then the gutters closest to the nominal one.
    const drift = candidate.reduce((sum, value, index) => sum + Math.abs(value - layout.gutterX) * (index + 1), 0);
    const score = crossings * 10_000 + drift;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

export type PortraitPill = Readonly<{ side: 'left' | 'right'; y: number }>;

/**
 * 9:16 callouts: pills alternate left/right beside the phone on short leaders,
 * each level with its box where possible, nudged apart on the same side.
 */
export function layoutPortraitPills(
  boxes: readonly CanvasRect[],
  canvasHeight: number,
  minGap: number = SHOWCASE_CALLOUT_LAYOUT.portraitMinGap,
): PortraitPill[] {
  const placed: PortraitPill[] = [];
  boxes.forEach((box, index) => {
    const side = index % 2 === 0 ? 'left' : 'right';
    let y = box.y + box.height / 2;
    for (const other of placed) {
      if (other.side === side && Math.abs(other.y - y) < minGap) y = other.y + minGap;
    }
    placed.push({ side, y: Math.max(minGap, Math.min(canvasHeight - minGap, y)) });
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
  name: ShowcaseAnchorName;
  label: string;
  role: CalloutRole;
  /** 16:9: pill slot y and the leader's gutter x. 9:16: pill side and y. */
  slotY: number;
  gutterX: number;
  side: 'left' | 'right';
}>;

export type StageTake = Readonly<{
  frameUrlBase: string;
  frameCount: number;
  screen: Readonly<{ width: number; height: number }>;
  anchors: Partial<Record<ShowcaseAnchorName, readonly ShowcaseAnchorSample[]>>;
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
  /** Lit holds of the light take's first frame, in screen points. */
  holds: readonly LitHold[];
  copy: ShowcaseCopy;
  grades: Record<string, Readonly<{ background: string; ink: string }>>;
  /** The two backgrounds the stage tweens between, in OKLab. */
  palette: Readonly<{ stageDark: string; stageLight: string }>;
  markUrl: string;
  leadFrames: number;
}>;

/**
 * Callouts that can be drawn: the scene asks for them and the take reports the
 * anchor on screen when the callouts arrive. Anything else is skipped with a
 * warning rather than pointing a leader at nothing.
 */
export function resolveSceneCallouts(
  scene: ShowcaseScene,
  anchorsFile: ShowcaseAnchorsFile | null,
  labels: Partial<Record<ShowcaseAnchorName, string>>,
): { callouts: ShowcaseAnchorName[]; warnings: string[] } {
  const callouts: ShowcaseAnchorName[] = [];
  const warnings: string[] = [];
  const take = scene.takes[0];
  const t = (SHOWCASE_TAKE_LEAD_FRAMES + SHOWCASE_CHOREO.calloutStart) / SHOWCASE_FPS;
  for (const name of scene.callouts) {
    const samples = anchorsFile?.anchors[name];
    const rect = samples ? anchorAt(samples, t) : null;
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
  names: readonly ShowcaseAnchorName[],
  anchorsFile: ShowcaseAnchorsFile,
  labels: Partial<Record<ShowcaseAnchorName, string>>,
): StageCallout[] {
  const canvas = SHOWCASE_CANVAS[format];
  const calloutPose = SHOWCASE_POSES[format].CALLOUT;
  const t = (SHOWCASE_TAKE_LEAD_FRAMES + SHOWCASE_CHOREO.calloutStart) / SHOWCASE_FPS;
  const boxes = names.map((name) => {
    const rect = anchorAt(anchorsFile.anchors[name] ?? [], t);
    if (!rect) throw new Error(`Anchor ${name} has no samples`);
    return screenToCanvas(rect, anchorsFile.screen, calloutPose, canvas);
  });
  const roles = names.map((_, index) => CALLOUT_ROLES[Math.min(index, CALLOUT_ROLES.length - 1)]);
  if (format === '16x9') {
    const slots = calloutSlots(names.length);
    const pad = SHOWCASE_CALLOUT_LAYOUT.boxPadding;
    const starts = boxes.map((box) => ({ x: box.x + box.width + pad, y: box.y + box.height / 2 }));
    const gutters = assignLeaderGutters(starts, slots);
    return names.map((name, index) => ({
      name,
      label: labels[name] ?? name,
      role: roles[index],
      slotY: slots[index],
      gutterX: gutters[index],
      side: 'right',
    }));
  }
  const pills = layoutPortraitPills(boxes, canvas.height);
  return names.map((name, index) => ({
    name,
    label: labels[name] ?? name,
    role: roles[index],
    slotY: pills[index].y,
    gutterX: 0,
    side: pills[index].side,
  }));
}

// --- stills ----------------------------------------------------------------------

export type StillFrame = Readonly<{ frame: number; label: string }>;

/**
 * Frames for one scene's contact sheet: its settled frame first, then the
 * entrance, the mid-transitions either side, and for the outro the loop seam.
 */
export function stillFramesForScene(scene: ShowcaseScene, totalFrames = SHOWCASE_TOTAL_FRAMES): StillFrame[] {
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
  if (scene.id === 'outro') {
    frames.splice(4, 2, { frame: totalFrames - 12, label: 'closer -12' }, { frame: totalFrames - 1, label: 'last' });
    frames.push({ frame: 0, label: 'frame 0' });
  }
  const unique = new Map<number, StillFrame>();
  for (const still of frames) if (!unique.has(still.frame)) unique.set(still.frame, still);
  return [...unique.values()];
}

// --- encoding ------------------------------------------------------------------------

/** Hard gate: `scripts/check-large-files.mjs` fails at 2 MB; stay clear of it. */
export const SHOWCASE_WEB_MAX_BYTES = 1_800_000;
export const SHOWCASE_MASTER_CRF = 18;
/** The web cut drops frame 0 (the poster, which the page shows before playback) and loops 1..end. */
export const SHOWCASE_WEB_FIRST_FRAME = 1;
export const SHOWCASE_WEB_FALLBACK_MP4 = { width: 1280, height: 720 } as const;

export const webCutSeconds = (totalFrames = SHOWCASE_TOTAL_FRAMES): number =>
  (totalFrames - SHOWCASE_WEB_FIRST_FRAME) / SHOWCASE_FPS;

/** Video bitrate (kbit/s) that lands a `seconds`-long encode under `maxBytes` with `headroom` spare. */
export function webBitrateKbps(maxBytes: number, seconds: number, headroom = 0.12): number {
  return Math.floor((maxBytes * 8 * (1 - headroom)) / seconds / 1000);
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

/** Drops the poster frame from the web cut. */
const webTrim = `trim=start_frame=${SHOWCASE_WEB_FIRST_FRAME},setpts=PTS-STARTPTS`;

export type WebEncode = Readonly<{
  input: string;
  output: string;
  bitrateKbps: number;
  passLog: string;
  size?: Readonly<{ width: number; height: number }>;
}>;

/** VP9 two-pass at a target bitrate. Pass 1 writes only the log. */
export function buildWebmPassArgs({ input, output, bitrateKbps, passLog, size }: WebEncode, pass: 1 | 2): string[] {
  return [
    '-y',
    '-loglevel',
    'error',
    '-i',
    input,
    '-an',
    '-vf',
    `${webTrim},${toBt709(size)}`,
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
export function buildWebMp4PassArgs({ input, output, bitrateKbps, passLog, size }: WebEncode, pass: 1 | 2): string[] {
  return [
    '-y',
    '-loglevel',
    'error',
    '-i',
    input,
    '-an',
    '-vf',
    `${webTrim},${toBt709(size)}`,
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

export type PlaceholderTake = Readonly<{
  source: Readonly<{ kind: 'video'; file: string; seek: number }> | Readonly<{ kind: 'still'; file: string }>;
  anchors: Partial<Record<ShowcaseAnchorName, ShowcaseAnchorRect>>;
}>;

/**
 * Stand-in footage until the recorder lands real takes: committed help clips
 * (real app recordings) and store screenshots. Anchor rects are hand-measured on
 * those sources in points. `invite-qr` has no QR on the queue still, so it
 * borrows the history button to keep the three-callout layout honest.
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
  crew: {
    source: { kind: 'still', file: 'queue.webp' },
    anchors: {
      'invite-qr': { x: 26, y: 175, width: 46, height: 46 },
      'queue-row-avatar': { x: 397, y: 282, width: 22, height: 22 },
      'play-next': { x: 18, y: 359, width: 412, height: 102 },
    },
  },
  log: { source: { kind: 'video', file: 'logbook-swipe-edit-delete.mp4', seek: 0 }, anchors: {} },
};

export function buildPlaceholderFootageArgs(takeId: ShowcaseTakeId, take: PlaceholderTake, outDir: string): string[] {
  const seconds = requiredTakeSeconds(takeId);
  const input =
    take.source.kind === 'video'
      ? ['-ss', String(take.source.seek), '-i', resolve(HELP_CLIP_VIDEO_DIR, take.source.file)]
      : ['-loop', '1', '-i', resolve(SHOWCASE_STORE_STILL_DIR, take.source.file)];
  return [
    '-y',
    '-loglevel',
    'error',
    ...input,
    '-t',
    String(seconds),
    // A clip shorter than the take holds its last frame.
    '-vf',
    `fps=${SHOWCASE_FPS},scale=${SHOWCASE_FOOTAGE_WIDTH}:-2:flags=lanczos,tpad=stop_mode=clone:stop_duration=${Math.ceil(seconds)}`,
    '-frames:v',
    String(Math.ceil(seconds * SHOWCASE_FPS)),
    '-q:v',
    '3',
    resolve(outDir, '%05d.jpg'),
  ];
}

export function placeholderAnchorsFile(takeId: ShowcaseTakeId, take: PlaceholderTake): ShowcaseAnchorsFile {
  const anchors: Partial<Record<ShowcaseAnchorName, ShowcaseAnchorSample[]>> = {};
  for (const [name, rect] of Object.entries(take.anchors) as [ShowcaseAnchorName, ShowcaseAnchorRect][]) {
    anchors[name] = [{ t: 0, ...rect }];
  }
  return { takeId, screen: PLACEHOLDER_SCREEN, anchors };
}

// --- CLI ------------------------------------------------------------------------------

export type RenderArgs = Readonly<{
  stills: boolean;
  measure: boolean;
  fromFrame: number;
  formats: readonly ShowcaseFormat[];
  placeholderFootage: boolean;
  skipWeb: boolean;
  help: boolean;
}>;

export function parseRenderArgs(argv: readonly string[]): RenderArgs {
  let stills = false;
  let measure = false;
  let fromFrame = 0;
  let formats: ShowcaseFormat[] = [...SHOWCASE_FORMATS];
  let placeholderFootage = false;
  let skipWeb = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--help' || argument === '-h')
      return { stills, measure, fromFrame, formats, placeholderFootage, skipWeb, help: true };
    if (argument === '--stills') stills = true;
    else if (argument === '--measure') measure = true;
    else if (argument === '--placeholder-footage') placeholderFootage = true;
    else if (argument === '--skip-web') skipWeb = true;
    else if (argument === '--from-frame' || argument === '--format') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value`);
      index += 1;
      if (argument === '--from-frame') {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed >= SHOWCASE_TOTAL_FRAMES || String(parsed) !== value) {
          throw new Error(`--from-frame must be an integer in 0..${SHOWCASE_TOTAL_FRAMES - 1}`);
        }
        fromFrame = parsed;
      } else {
        if (!(SHOWCASE_FORMATS as readonly string[]).includes(value)) {
          throw new Error(`--format must be one of ${SHOWCASE_FORMATS.join(', ')}`);
        }
        formats = [value as ShowcaseFormat];
      }
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return { stills, measure, fromFrame, formats, placeholderFootage, skipWeb, help: false };
}
