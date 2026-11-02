import 'server-only';
import { cache } from 'react';
import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';
import { getAllBoardConfigsOrThrow } from '@/app/lib/server-popular-configs';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { getSetterPageData, type SetterPageData } from './server-setter-data';
import { resolveSetterClimbLinks, type SetterClimbLinks } from './setter-climb-links';

/**
 * Everything the setter front door needs to decide BOTH what it renders and
 * whether that is worth indexing — resolved once per request.
 *
 * `generateMetadata` and the page body used to answer different questions from
 * different data: metadata asked "does this setter exist" and the body asked
 * "which of their climbs can I link". A setter every one of whose climbs sits
 * on a configuration the climbs sitemap cannot resolve therefore got an
 * `index, follow` page carrying an `<h1>`, fifty board images and zero climb
 * anchors. On the dev image that is 22,490 of the 91,946 setters who now answer
 * 200 (24.5%).
 *
 * `cache()` is what makes asking twice free: Next runs `generateMetadata` and
 * the page render inside one request scope, so the second call is the first
 * call's result rather than a second round of queries.
 */
export type SetterPageView = {
  data: SetterPageData;
  links: SetterClimbLinks;
  /** True when at least one row on THIS page renders a real climb anchor. */
  hasCrawlableClimb: boolean;
  /** True when the board catalogue was unavailable and every climb renders unlinked. */
  linksDegraded: boolean;
};

/**
 * The board catalogue only decides which rows get an anchor here, so a miss
 * (cold backend cache, 3 s deadline, rate limit) renders the climbs unlinked
 * instead of failing the page. The sitemap keeps the fail-closed read: there an
 * empty answer would tell Google the pages were deleted. The underlying fetch is
 * not cancelled; its single-flight fills the in-process cache for the next request.
 */
function startBoardConfigs(): Promise<PopularBoardConfig[] | null> {
  return getAllBoardConfigsOrThrow().catch((error: unknown) => {
    console.warn('[setter] board catalogue unavailable; rendering climbs unlinked', error);
    return null;
  });
}

/**
 * The 3 s deadline counts from when the fetch started, but is only raced once the
 * setter read has finished. A catalogue that answered while the DB read was still
 * running is already settled and wins; the page degrades only when the catalogue
 * itself is the slow part.
 */
async function awaitBoardConfigs(
  pending: Promise<PopularBoardConfig[] | null>,
  startedAt: number,
): Promise<PopularBoardConfig[] | null> {
  const remainingMs = Math.max(0, SSR_BACKEND_FETCH_TIMEOUT_MS - (Date.now() - startedAt));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), remainingMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const getSetterPageView = cache(async (username: string, page: number): Promise<SetterPageView | null> => {
  // Started first so the two reads run in parallel.
  const startedAt = Date.now();
  const configsPending = startBoardConfigs();
  const data = await getSetterPageData(username, page);
  if (!data) return null;

  const configs = await awaitBoardConfigs(configsPending, startedAt);
  const links = resolveSetterClimbLinks(data.climbs, configs ?? []);

  return {
    data,
    links,
    hasCrawlableClimb: data.climbs.some((climb) => !links.unlinkedClimbUuids.has(climb.uuid)),
    linksDegraded: configs === null,
  };
});

/**
 * The robots half of the question above, made safe to ask from metadata.
 *
 * Answers `true` on every failure on purpose, and when the view rendered with
 * the catalogue missing (`linksDegraded`). A catalogue blip is not evidence that a
 * setter's climbs stopped being linkable — de-indexing the entire setter tree
 * for the length of one incident is far worse than indexing a few link-less
 * pages for the length of one crawl.
 *
 * `null` (the setter has no visible climb) also answers `true`: that page
 * 404s, so its robots directive is never served.
 */
export async function setterPageHasCrawlableClimb(username: string, page: number): Promise<boolean> {
  try {
    const view = await getSetterPageView(username, page);
    return view === null || view.linksDegraded || view.hasCrawlableClimb;
  } catch {
    return true;
  }
}
