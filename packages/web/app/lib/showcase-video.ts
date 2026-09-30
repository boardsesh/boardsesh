import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';

/**
 * The homepage showcase video: one 16:9 cut for desktop and one 9:16 cut for
 * phones (viewport 760 px and under), each as VP9 webm and H.264 mp4, plus a
 * poster per cut. The files are rendered by `render-showcase-video.ts`; the
 * first frame of each video is its poster.
 */

/** Same breakpoint as the rest of the homepage's phone layout. */
export const SHOWCASE_PHONE_MEDIA = '(max-width: 760px)';

export type ShowcaseVideoCut = { webm: string; mp4: string; poster: string };

export type ShowcaseVideoSources = {
  wide: ShowcaseVideoCut;
  tall: ShowcaseVideoCut;
};

export function showcaseVideoSources(): ShowcaseVideoSources {
  return {
    wide: {
      webm: resolveStaticAssetUrl('/videos/home/showcase.webm'),
      mp4: resolveStaticAssetUrl('/videos/home/showcase.mp4'),
      poster: resolveStaticAssetUrl('/images/home/showcase-poster.webp'),
    },
    tall: {
      webm: resolveStaticAssetUrl('/videos/home/showcase-9x16.webm'),
      mp4: resolveStaticAssetUrl('/videos/home/showcase-9x16.mp4'),
      poster: resolveStaticAssetUrl('/images/home/showcase-poster-9x16.webp'),
    },
  };
}
