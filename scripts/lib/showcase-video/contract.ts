import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The contract between the three halves of the homepage showcase video:
 *
 * - the recorder (`scripts/showcase-video-record.ts`) drives the simulator and
 *   writes footage frames + anchor samples for every take,
 * - the mobile app (screenshot mode) logs where each callout target sits on
 *   screen, so callouts follow the UI without hand-measured boxes,
 * - the renderer (`packages/web/scripts/render-showcase-video.ts`) lays the
 *   footage into the stage in `marketing/showcase-video/` and encodes it.
 *
 * Anything two of those halves both read lives here. Scene timing lives in
 * `timeline.ts`, capture details in `takes.ts`.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const SHOWCASE_FPS = 30;
export const SHOWCASE_WIDTH = 1920;
export const SHOWCASE_HEIGHT = 1080;

/** Committed stage: HTML, CSS, timeline script, fonts, copy. */
export const SHOWCASE_STAGE_DIR = resolve(REPO_ROOT, 'marketing/showcase-video');
/** Gitignored working tree for one record + render cycle. */
export const SHOWCASE_WORK_ROOT = resolve(REPO_ROOT, '.boardsesh/showcase-video');
export const SHOWCASE_RAW_DIR = resolve(SHOWCASE_WORK_ROOT, 'work/raw');
export const SHOWCASE_FOOTAGE_DIR = resolve(SHOWCASE_WORK_ROOT, 'work/footage');
export const SHOWCASE_ANCHORS_DIR = resolve(SHOWCASE_WORK_ROOT, 'work/anchors');
export const SHOWCASE_OUT_DIR = resolve(SHOWCASE_WORK_ROOT, 'out');

/** Shipped web encodes and posters (committed, uploaded by the static-asset sync). */
export const SHOWCASE_WEB_VIDEO_DIR = resolve(REPO_ROOT, 'packages/web/public/videos/home');
export const SHOWCASE_WEB_POSTER_DIR = resolve(REPO_ROOT, 'packages/web/public/images/home');

/**
 * Footage frames are a 30 fps JPEG sequence per take, `00001.jpg` upward, at
 * this width (2x the on-canvas phone screen so the 2x-supersampled render stays
 * sharp). Height follows the recording's aspect.
 */
export const SHOWCASE_FOOTAGE_WIDTH = 800;
export const footageFramePath = (takeId: ShowcaseTakeId, frameIndex: number): string =>
  resolve(SHOWCASE_FOOTAGE_DIR, takeId, `${String(frameIndex + 1).padStart(5, '0')}.jpg`);

/**
 * Every recorded take. A scene may use more than one (the boards scene shows
 * three phones, one take each).
 */
export const SHOWCASE_TAKE_IDS = [
  'light',
  'boards-kilter',
  'boards-tension',
  'boards-moonboard',
  'crew',
  'log',
] as const;
export type ShowcaseTakeId = (typeof SHOWCASE_TAKE_IDS)[number];

/**
 * Callout targets the app reports in screenshot mode. The mobile hook
 * `useShowcaseAnchor(name)` accepts exactly these names.
 */
export const SHOWCASE_ANCHOR_NAMES = [
  'wall-pill',
  'board-surface',
  'invite-qr',
  'queue-row-avatar',
  'play-next',
  'profile-board-filter',
] as const;
export type ShowcaseAnchorName = (typeof SHOWCASE_ANCHOR_NAMES)[number];

/**
 * What the app prints (via `console.log`, which Metro forwards) whenever an
 * anchored view lays out in screenshot mode:
 *
 *   [showcase-anchor] {"name":"wall-pill","x":24,"y":118,"width":132,"height":32}
 *
 * Coordinates are `measureInWindow` points (not pixels). The recorder stamps
 * each line with the time it arrived, relative to the take's recording start.
 */
export const SHOWCASE_ANCHOR_LOG_PREFIX = '[showcase-anchor]';

export type ShowcaseAnchorRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type ShowcaseAnchorLogLine = ShowcaseAnchorRect & Readonly<{ name: ShowcaseAnchorName }>;

/** One sample: where the anchor was from `t` seconds into the trimmed take onward. */
export type ShowcaseAnchorSample = ShowcaseAnchorRect & Readonly<{ t: number }>;

/** `work/anchors/<takeId>.json`, written by the recorder, read by the renderer. */
export type ShowcaseAnchorsFile = Readonly<{
  takeId: ShowcaseTakeId;
  /** Screen size in points (e.g. 440x956 on an iPhone 16 Pro Max), to map points onto footage. */
  screen: Readonly<{ width: number; height: number }>;
  anchors: Partial<Record<ShowcaseAnchorName, readonly ShowcaseAnchorSample[]>>;
}>;

export function parseShowcaseAnchorLine(line: string): ShowcaseAnchorLogLine | null {
  const at = line.indexOf(SHOWCASE_ANCHOR_LOG_PREFIX);
  if (at === -1) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(at + SHOWCASE_ANCHOR_LOG_PREFIX.length).trim());
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { name, x, y, width, height } = parsed as Record<string, unknown>;
    if (!(SHOWCASE_ANCHOR_NAMES as readonly unknown[]).includes(name)) return null;
    if (![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
    return {
      name: name as ShowcaseAnchorName,
      x: x as number,
      y: y as number,
      width: width as number,
      height: height as number,
    };
  } catch {
    return null;
  }
}

/** The anchor rect in force at `t` seconds: the last sample at or before `t`, else the first. */
export function anchorAt(samples: readonly ShowcaseAnchorSample[], t: number): ShowcaseAnchorRect | null {
  if (samples.length === 0) return null;
  let current = samples[0];
  for (const sample of samples) {
    if (sample.t <= t) current = sample;
    else break;
  }
  return current;
}
