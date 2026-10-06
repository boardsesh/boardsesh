import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import { absoluteUrl } from '@/app/lib/seo/base-url';

/**
 * The homepage hero video. One 9:16 lite cut (720 x 1280) for every viewport,
 * as VP9 webm and H.264 mp4, plus a poster whose pixels are the video's first
 * frame. The files are rendered by `render-showcase-video.ts`.
 */

export const SHOWCASE_POSTER_WIDTH = 720;
export const SHOWCASE_POSTER_HEIGHT = 1280;

/** The `cut` property on `Showcase Video Progress`. */
export const SHOWCASE_CUT = '9x16-lite';

export const SHOWCASE_VIDEO_PROGRESS_EVENT = 'Showcase Video Progress';

export type ShowcaseQuartile = 25 | 50 | 75 | 100;

/**
 * `timeupdate` fires about four times a second and the loop wraps to zero, so a
 * clock that never reads exactly the duration would never report 100. The last
 * three percent (about a second) counts as finished.
 */
export const SHOWCASE_QUARTILE_THRESHOLDS: readonly { quartile: ShowcaseQuartile; progress: number }[] = [
  { quartile: 25, progress: 0.25 },
  { quartile: 50, progress: 0.5 },
  { quartile: 75, progress: 0.75 },
  { quartile: 100, progress: 0.97 },
];

export type ShowcaseVideoProgressProperties = {
  quartile: ShowcaseQuartile;
  placement: 'hero';
  cut: typeof SHOWCASE_CUT;
  autoplayed: boolean;
};

export type ShowcaseVideoSources = { webm: string; mp4: string; poster: string };

export function showcaseVideoSources(): ShowcaseVideoSources {
  return {
    webm: resolveStaticAssetUrl('/videos/home/showcase-9x16-lite.webm'),
    mp4: resolveStaticAssetUrl('/videos/home/showcase-9x16-lite.mp4'),
    poster: resolveStaticAssetUrl('/images/home/showcase-hero-9x16.webp'),
  };
}

function toAbsolute(url: string): string {
  return url.startsWith('http') ? url : absoluteUrl(url);
}

/** Schema.org `VideoObject` for the homepage. English only: the video's text is English. */
export function showcaseVideoJsonLd(): Record<string, unknown> {
  const { mp4, poster } = showcaseVideoSources();
  return {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: 'Boardsesh in under a minute',
    description:
      'Use every board in one app, including your own spray wall, run a shared crew queue, plan a workout and log a send in Boardsesh. Works with Kilter, Tension and MoonBoard.',
    thumbnailUrl: toAbsolute(poster),
    uploadDate: '2026-10-06T00:00:00+10:00',
    duration: 'PT54.8S',
    contentUrl: toAbsolute(mp4),
  };
}
