import { createOgImageHeaders } from '@boardsesh/board-render';

/** Identity-bearing previews must reauthorize even at an old versioned URL. */
export function createPrivateOgImageHeaders(
  options: Parameters<typeof createOgImageHeaders>[0],
): Record<string, string> {
  return {
    ...createOgImageHeaders(options),
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store',
  };
}
