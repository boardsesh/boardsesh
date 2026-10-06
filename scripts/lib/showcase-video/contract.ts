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
export const SHOWCASE_MARKS_DIR = resolve(SHOWCASE_WORK_ROOT, 'work/marks');
export const SHOWCASE_OUT_DIR = resolve(SHOWCASE_WORK_ROOT, 'out');

/**
 * The phone the takes were recorded on. iOS is the default and keeps the
 * original `work/<kind>/` paths; every other platform records into
 * `work/<platform>/<kind>/`, so an Android run never overwrites the iOS
 * footage the homepage is cut from.
 */
export const SHOWCASE_PLATFORMS = ['ios', 'android'] as const;
export type ShowcasePlatform = (typeof SHOWCASE_PLATFORMS)[number];
export const DEFAULT_SHOWCASE_PLATFORM: ShowcasePlatform = 'ios';

export function isShowcasePlatform(value: unknown): value is ShowcasePlatform {
  return (SHOWCASE_PLATFORMS as readonly unknown[]).includes(value);
}

export type ShowcaseWorkDirs = Readonly<{ raw: string; footage: string; anchors: string; marks: string }>;

/** Where one platform's recording lives. iOS: `work/footage`; Android: `work/android/footage`. */
export function showcaseWorkDirs(platform: ShowcasePlatform = DEFAULT_SHOWCASE_PLATFORM): ShowcaseWorkDirs {
  const base = platform === 'ios' ? resolve(SHOWCASE_WORK_ROOT, 'work') : resolve(SHOWCASE_WORK_ROOT, 'work', platform);
  return {
    raw: resolve(base, 'raw'),
    footage: resolve(base, 'footage'),
    anchors: resolve(base, 'anchors'),
    marks: resolve(base, 'marks'),
  };
}

/** Shipped web encodes and posters (committed, uploaded by the static-asset sync). */
export const SHOWCASE_WEB_VIDEO_DIR = resolve(REPO_ROOT, 'packages/web/public/videos/home');
export const SHOWCASE_WEB_POSTER_DIR = resolve(REPO_ROOT, 'packages/web/public/images/home');

/**
 * Footage frames are a 30 fps JPEG sequence per take, `00001.jpg` upward, at
 * this width (2x the on-canvas phone screen so the 2x-supersampled render stays
 * sharp). Height follows the recording's aspect.
 */
export const SHOWCASE_FOOTAGE_WIDTH = 800;
export const footageFramePath = (
  takeId: ShowcaseTakeId,
  frameIndex: number,
  platform: ShowcasePlatform = DEFAULT_SHOWCASE_PLATFORM,
): string => resolve(showcaseWorkDirs(platform).footage, takeId, `${String(frameIndex + 1).padStart(5, '0')}.jpg`);

/**
 * Every recorded take. A scene may use more than one (the boards scene shows
 * several phones, one take per board).
 */
export const SHOWCASE_TAKE_IDS = [
  'boards-kilter',
  'boards-tension',
  'boards-spray',
  'boards-moonboard',
  'boards-woods',
  'boards-decoy',
  'boards-touchstone',
  'boards-grasshopper',
  'boards-soill',
  'spray',
  'wall',
  'crew',
  'workouts',
  'lock-screen',
  'log',
] as const;
export type ShowcaseTakeId = (typeof SHOWCASE_TAKE_IDS)[number];

/**
 * Callout targets the app reports in screenshot mode. The mobile hook
 * `useShowcaseAnchor(name)` accepts exactly these names, and the mobile drift
 * test (`packages/mobile/src/lib/__tests__/showcase-anchor.test.ts`) pins this
 * list against the app's copy.
 */
export const SHOWCASE_ANCHOR_NAMES = [
  'board-surface',
  'invite-qr',
  'queue-row-avatar',
  'play-next',
  'profile-board-filter',
  'board-history-button',
  'now-on-wall',
  'wall-history',
  'workout-type',
  'rest-timer',
  'activity-calendar',
] as const;
export type ShowcaseAnchorName = (typeof SHOWCASE_ANCHOR_NAMES)[number];

/**
 * Callout targets the app can't log: the Live Activity's lock-screen buttons
 * run in a widget process, outside the JS bundle. The recorder authors their
 * rects from a measured reference capture instead.
 */
export const SHOWCASE_STATIC_ANCHOR_NAMES = ['lock-next', 'lock-relight', 'lock-mirror'] as const;
export type ShowcaseStaticAnchorName = (typeof SHOWCASE_STATIC_ANCHOR_NAMES)[number];

/** Anything a scene may point a callout at: app-logged or recorder-authored. */
export type ShowcaseCalloutName = ShowcaseAnchorName | ShowcaseStaticAnchorName;

/**
 * What the app prints (via `console.log`, which Metro forwards) whenever an
 * anchored view lays out in screenshot mode:
 *
 *   [showcase-anchor] {"name":"invite-qr","x":120,"y":118,"width":200,"height":200}
 *
 * Coordinates are `measureInWindow` points (not pixels; dp on Android). The recorder stamps
 * each line with the time it arrived, relative to the take's recording start.
 */
export const SHOWCASE_ANCHOR_LOG_PREFIX = '[showcase-anchor]';

export type ShowcaseAnchorRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type ShowcaseAnchorLogLine = ShowcaseAnchorRect & Readonly<{ name: ShowcaseAnchorName }>;

/** One sample: where the anchor was from `t` seconds into the trimmed take onward. */
export type ShowcaseAnchorSample = ShowcaseAnchorRect & Readonly<{ t: number }>;

/**
 * `work/anchors/<takeId>.json`, written by the recorder, read by the renderer.
 * Keyed by callout name, so a take can carry recorder-authored static anchors
 * (the lock-screen buttons) beside the app-logged ones. Each list is sorted
 * ascending by `t` (see `anchorAt` and `sortAnchorSamples`).
 */
export type ShowcaseAnchorsFile = Readonly<{
  takeId: ShowcaseTakeId;
  /**
   * Screen size in points (e.g. 440x956 on an iPhone 16 Pro Max; 411x923 dp on
   * the 1080x2424, 420 dpi Android emulator), to map points onto footage.
   */
  screen: Readonly<{ width: number; height: number }>;
  anchors: Partial<Record<ShowcaseCalloutName, readonly ShowcaseAnchorSample[]>>;
}>;

/**
 * `work/marks/<takeId>.json`, written by the recorder, read by the renderer:
 * the moments a take's flow reached a step (a swipe, the island opening,
 * Next), in seconds from the start of the TRIMMED footage, so the renderer
 * can place cuts and callouts on events instead of hand-read frame numbers.
 * The flows raise them on the recorder's signal server as `/mark/<name>`
 * right after the step's action; each take's flow header lists its marks, and
 * docs/showcase-video.md collects them. A mark the flow never reached is
 * absent. Marks the recorder derives itself (from an anchor's first sample)
 * are listed in docs/showcase-video.md too.
 */
export type ShowcaseMarksFile = Readonly<{
  takeId: ShowcaseTakeId;
  marks: Readonly<Record<string, number>>;
}>;

/** Samples in ascending `t`, the order `anchorAt` needs. Returns a new array; stable for equal `t`. */
export function sortAnchorSamples(samples: readonly ShowcaseAnchorSample[]): ShowcaseAnchorSample[] {
  return [...samples].sort((a, b) => a.t - b.t);
}

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

/**
 * The anchor rect in force at `t` seconds: the last sample at or before `t`,
 * else the first.
 *
 * `samples` MUST be sorted ascending by `t`: the scan stops at the first sample
 * after `t`, so an unsorted list silently returns a stale rect. The recorder
 * writes each list through `sortAnchorSamples`, and a reader that can't vouch
 * for its input should run it through `sortAnchorSamples` once on load (cheap:
 * a take logs tens of samples), not per frame.
 */
export function anchorAt(samples: readonly ShowcaseAnchorSample[], t: number): ShowcaseAnchorRect | null {
  if (samples.length === 0) return null;
  let current = samples[0];
  for (const sample of samples) {
    if (sample.t <= t) current = sample;
    else break;
  }
  return current;
}
