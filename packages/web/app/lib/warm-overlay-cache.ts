import { headers } from 'next/headers';
import { buildOgBoardRenderUrl } from '@/app/components/board-renderer/util';
import { isCrawlerUserAgent } from '@/app/lib/is-crawler';
import type { BoardDetails, Climb } from '@/app/lib/types';

/** Ceiling on the one best-effort OG warm. It must never hold the SSR request open. */
const WARM_FETCH_TIMEOUT_MS = 5000;

type WarmOgImageOptions = {
  boardDetails: BoardDetails;
  climb: Pick<Climb, 'frames'>;
};

/**
 * Prime the backend's OG byte cache for a human climb view without warming the
 * board overlay itself. The overlay is already discovered early through the
 * server-rendered preload + `<img>` and now goes straight to Cloudflare/Railway;
 * a Vercel-side warm would only put pooled egress traffic into the renderer's
 * load queue and duplicate the browser's real request.
 */
export function scheduleOgImageWarming(options: WarmOgImageOptions): void {
  const pendingHeaders = requestHeadersOrNull();
  if (!pendingHeaders) return;

  void warmUnlessCrawler(pendingHeaders, options);
}

function requestHeadersOrNull(): ReturnType<typeof headers> | null {
  try {
    return headers();
  } catch {
    return null;
  }
}

async function warmUnlessCrawler(
  pendingHeaders: ReturnType<typeof headers>,
  options: WarmOgImageOptions,
): Promise<void> {
  try {
    if (isCrawlerUserAgent((await pendingHeaders).get('user-agent'))) return;
  } catch {
    return;
  }
  await warmOgImage(options);
}

// Exported for tests; `scheduleOgImageWarming` is the production entry point.
export async function warmOgImage({ boardDetails, climb }: WarmOgImageOptions): Promise<void> {
  try {
    const ogUrl = buildOgBoardRenderUrl(boardDetails, climb.frames);
    if (!ogUrl.startsWith('http')) return;

    await fetch(ogUrl, { signal: AbortSignal.timeout(WARM_FETCH_TIMEOUT_MS) })
      .then((response) => response.body?.cancel())
      .catch(() => {});
  } catch {
    // Warming failures must never propagate into the page render.
  }
}
