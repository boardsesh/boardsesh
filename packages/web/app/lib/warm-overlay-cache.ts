import { buildOverlayUrl } from '@/app/components/board-renderer/util';
import type { BoardDetails, Climb } from '@/app/lib/types';

const BASE_URL = process.env.VERCEL_URL ? 'https://www.boardsesh.com' : 'http://localhost:3000';

/**
 * Fire-and-forget fetches to warm the Vercel Edge CDN cache for
 * WASM-rendered board overlay images. Fetches start immediately
 * (overlapping with SSR response streaming) so overlays are cached
 * before the client hydrates and requests them.
 */
export function scheduleOverlayWarming(options: {
  boardDetails: BoardDetails;
  climbs: Pick<Climb, 'frames'>[];
  variant: 'thumbnail' | 'full';
  maxImages?: number;
}): void {
  // Fire-and-forget — don't await. The serverless function stays alive
  // while the SSR response is still streaming, giving these fetches
  // time to complete and populate the CDN cache.
  void warmOverlays(options);
}

async function warmOverlays(options: {
  boardDetails: BoardDetails;
  climbs: Pick<Climb, 'frames'>[];
  variant: 'thumbnail' | 'full';
  maxImages?: number;
}): Promise<void> {
  try {
    const { boardDetails, climbs, variant, maxImages = 20 } = options;
    const isThumbnail = variant === 'thumbnail';
    const toWarm = climbs.slice(0, maxImages);

    await Promise.allSettled(
      toWarm.map((climb) => {
        const path = buildOverlayUrl(boardDetails, climb.frames, isThumbnail);
        return fetch(`${BASE_URL}${path}`).then((r) => r.body?.cancel());
      }),
    );
  } catch {
    // Warming failures must never propagate
  }
}
