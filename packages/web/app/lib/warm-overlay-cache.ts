import { buildOgBoardRenderUrl, buildOverlayUrl } from '@/app/components/board-renderer/util';
import { SITE_URL } from '@/app/lib/seo/base-url';
import type { BoardDetails, Climb } from '@/app/lib/types';

const BASE_URL = process.env.VERCEL_URL ? SITE_URL : 'http://localhost:3000';

/**
 * How many list rows the `/list` front door warms per SSR render.
 *
 * Each warm target is a same-origin `/api/internal/board-render` call — a
 * CPU-bound WASM render in the same runtime — so the default 20 turned one
 * crawled list page into 20 extra invocations competing with the request that
 * spawned them. Six is roughly what a reader sees before scrolling.
 */
export const FRONT_DOOR_WARM_LIMIT = 6;

/** Ceiling on a single warm fetch. A never-settling one keeps the instance (and its pool slots) alive. */
const WARM_FETCH_TIMEOUT_MS = 5000;

type WarmOverlaysOptions = {
  boardDetails: BoardDetails;
  climbs: Pick<Climb, 'frames'>[];
  variant: 'thumbnail' | 'full';
  maxImages?: number;
};

/**
 * Fire-and-forget fetches to warm the Vercel Edge CDN cache for
 * WASM-rendered board overlay images. Fetches start immediately
 * (overlapping with SSR response streaming) so overlays are cached
 * before the client hydrates and requests them.
 *
 * On the climb view pages (`variant: 'full'`) this also warms the shared
 * og:image on the backend, so the base+byte caches are primed before anyone
 * shares the climb — the first crawler fetch is then a warm hit.
 */
export function scheduleOverlayWarming(options: WarmOverlaysOptions): void {
  // Fire-and-forget — don't await. The serverless function stays alive
  // while the SSR response is still streaming, giving these fetches
  // time to complete and populate the CDN cache.
  void warmOverlays(options);
}

// Exported for tests; `scheduleOverlayWarming` is the production entry point.
export async function warmOverlays(options: WarmOverlaysOptions): Promise<void> {
  try {
    const { boardDetails, climbs, variant, maxImages = 20 } = options;
    const isThumbnail = variant === 'thumbnail';
    const toWarm = climbs.slice(0, maxImages);

    const warmTargets: string[] = [];
    for (const climb of toWarm) {
      warmTargets.push(`${BASE_URL}${buildOverlayUrl(boardDetails, climb.frames, isThumbnail)}`);

      // Only the full climb-view pages warm the og card. A thumbnail list would
      // fan out one backend og render per row for images no crawler fetches.
      // Both full-variant call sites pass a single climb, so this is one og
      // request per view render (worst case maxImages og warms if that changes).
      // Skip the relative web-render fallback: only the absolute backend URL
      // primes the long-running renderer's base+byte caches.
      if (variant === 'full') {
        const ogUrl = buildOgBoardRenderUrl(boardDetails, climb.frames);
        if (ogUrl.startsWith('http')) {
          warmTargets.push(ogUrl);
        }
      }
    }

    await Promise.allSettled(
      warmTargets.map((url) =>
        fetch(url, { signal: AbortSignal.timeout(WARM_FETCH_TIMEOUT_MS) })
          .then((response) => response.body?.cancel())
          .catch(() => {}),
      ),
    );
  } catch {
    // Warming failures must never propagate
  }
}
