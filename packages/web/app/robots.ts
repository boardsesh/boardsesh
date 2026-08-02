import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/app/lib/seo/base-url';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      // robots.txt precedence is longest-path-match, not file order: these
      // two allow rules are more specific than the blanket `/api/` disallow
      // below, so they carve out Googlebot-Image access to the setter,
      // profile, playlist and session OG cards (buildVersionedOgImagePath
      // returns relative /api/og/... paths) and to /api/internal/board-render,
      // the climb page's LCP image. Climb OG cards use the absolute
      // https://ws.boardsesh.com/og/climb URL and never hit this rule.
      allow: ['/', '/api/og/', '/api/internal/board-render'],
      disallow: ['/feed', '/api/', '/auth/', '/settings', '/you', '/you/*'],
    },
    sitemap: absoluteUrl('/sitemap.xml'),
  };
}
