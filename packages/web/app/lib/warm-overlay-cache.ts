import { headers } from 'next/headers';
import { buildBoardArtLayers, buildOgBoardRenderUrl } from '@/app/components/board-renderer/util';
import { isCrawlerUserAgent } from '@/app/lib/is-crawler';
import { SITE_URL } from '@/app/lib/seo/base-url';
import type { BoardDetails, Climb } from '@/app/lib/types';

// Absolute base for the same-origin warm fetches below. Read per call rather
// than pinned at module scope: this used to be `VERCEL_URL ? SITE_URL :
// 'http://localhost:3000'`, which points every warm fetch at localhost on any
// host that isn't Vercel — on a hot SSR path, so the whole warm silently becomes
// a fan-out of connection refusals (#4651).
//
// A configured https BASE_URL wins (that is the deployment's canonical origin);
// otherwise the loopback default, which is what local dev wants and is the only
// thing a warm can reach when nothing names an origin.
function warmOrigin(): string {
  const configuredOrigin = process.env.BASE_URL?.trim();
  if (configuredOrigin?.startsWith('https://')) return configuredOrigin;
  const nextAuthOrigin = process.env.NEXTAUTH_URL?.trim();
  if (nextAuthOrigin?.startsWith('https://')) return nextAuthOrigin;
  // TODO(#4656): retire with the Vercel project. Unreachable in the nodejs
  // runtime today — instrumentation.ts patches NEXTAUTH_URL to the canonical
  // origin before any request is served — but kept so this stays a strict
  // superset of the behaviour it replaces.
  return process.env.VERCEL_URL ? SITE_URL : 'http://localhost:3000';
}

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
  const pendingHeaders = requestHeadersOrNull();
  // No request scope (a static prerender) — there is no visitor whose LCP this
  // would be racing, so there is nothing to warm for.
  if (!pendingHeaders) return;

  // Fire-and-forget — don't await. The serverless function stays alive
  // while the SSR response is still streaming, giving these fetches
  // time to complete and populate the CDN cache.
  void warmUnlessCrawler(pendingHeaders, options);
}

/**
 * `headers()` has to be CALLED synchronously inside the request scope to bind
 * to Next's async store — awaiting the promise later, inside the
 * fire-and-forget chain, is fine. Returns null instead of throwing so the
 * caller can treat "no request" as "nothing to warm".
 */
function requestHeadersOrNull(): ReturnType<typeof headers> | null {
  try {
    return headers();
  } catch {
    return null;
  }
}

/**
 * Warming for a crawler is pure waste: it renders the page and then never
 * fetches the image the warm just rendered. That is what made
 * `/api/internal/board-render` a shadow of the crawl rather than independent
 * traffic — measured 2026-08-25, board-render invocations tracked climb-view
 * invocations at 1.06:1, roughly one 3 GB WASM+sharp render per crawled climb
 * page (#4650).
 *
 * Googlebot-Image is unaffected: it still gets the image, rendered on demand
 * when it actually asks, which `app/robots.ts` explicitly allows. The rendered
 * HTML does not change either way — the warm is a pure side effect — so this
 * cannot fork the CDN entry between crawlers and humans.
 *
 * Fails CLOSED. A header read that throws skips the warm, because the cost of
 * a false skip is one un-warmed LCP image that renders on demand, while the
 * cost of a false warm is exactly the invocation this exists to remove.
 */
async function warmUnlessCrawler(
  pendingHeaders: ReturnType<typeof headers>,
  options: WarmOverlaysOptions,
): Promise<void> {
  try {
    if (isCrawlerUserAgent((await pendingHeaders).get('user-agent'))) return;
  } catch {
    return;
  }
  await warmOverlays(options);
}

// Exported for tests; `scheduleOverlayWarming` is the production entry point.
export async function warmOverlays(options: WarmOverlaysOptions): Promise<void> {
  try {
    const { boardDetails, climbs, variant, maxImages = 20 } = options;
    const isThumbnail = variant === 'thumbnail';
    const toWarm = climbs.slice(0, maxImages);

    const origin = warmOrigin();
    const warmTargets: string[] = [];
    for (const climb of toWarm) {
      // Through buildBoardArtLayers, not buildOverlayUrl: a themed board's page requests the
      // background-less overlay, so warming the with-background composite would render bytes
      // nobody fetches and leave the real request cold.
      const { overlayUrl } = buildBoardArtLayers(boardDetails, climb.frames, isThumbnail);
      if (overlayUrl) warmTargets.push(`${origin}${overlayUrl}`);

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
