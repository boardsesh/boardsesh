import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';

/**
 * Silent screen recordings for the /help topic pages.
 *
 * A clip earns its place only when a gesture is the thing being taught — a long
 * press, a swipe, a drag across the board. Everything else stays a still, which
 * costs the reader nothing to look at and carries a caption just as well.
 *
 * The names mirror `HELP_CLIPS` in `scripts/lib/help-clips.ts`, which is what
 * the converter writes from; `scripts/__tests__/help-clips.test.ts` holds the
 * two lists together, because a browser file cannot import from `scripts/`.
 */
export type HelpClipName =
  | 'long-press-climb-actions'
  | 'swipe-row-queue-playlist'
  | 'remove-from-playlist'
  | 'logbook-swipe-edit-delete'
  | 'hold-filter-paint'
  | 'zone-filter-drag'
  | 'grade-range-tap'
  | 'preview-browsing'
  | 'start-playlist-queue';

export type HelpClipSources = {
  mp4: string;
  webm: string;
  poster: string;
  width: number;
  height: number;
};

/**
 * The converter scales every recording to 736 px wide and encodes the poster at
 * 1600 px tall, matching the help stills exactly — so a clip and a still sit in
 * the same row without either one shifting the layout as it loads.
 */
// `help:convert-clips` refuses an encode that is not exactly this box, so the
// intrinsic size written on the <video> is never stale (scripts/lib/help-clips.ts).
const CLIP_WIDTH = 736;
const CLIP_HEIGHT = 1600;

export function helpClip(name: HelpClipName): HelpClipSources {
  return {
    mp4: resolveStaticAssetUrl(`/videos/help/${name}.mp4`),
    webm: resolveStaticAssetUrl(`/videos/help/${name}.webm`),
    poster: resolveStaticAssetUrl(`/images/help/clips/${name}.webp`),
    width: CLIP_WIDTH,
    height: CLIP_HEIGHT,
  };
}
