import 'server-only';
import { cache } from 'react';
import { getAllBoardConfigsOrThrow } from '@/app/lib/server-popular-configs';
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
};

export const getSetterPageView = cache(async (username: string, page: number): Promise<SetterPageView | null> => {
  const data = await getSetterPageData(username, page);
  if (!data) return null;

  const links = resolveSetterClimbLinks(data.climbs, await getAllBoardConfigsOrThrow());

  return {
    data,
    links,
    hasCrawlableClimb: data.climbs.some((climb) => !links.unlinkedClimbUuids.has(climb.uuid)),
  };
});

/**
 * The robots half of the question above, made safe to ask from metadata.
 *
 * Answers `true` on every failure on purpose. `getAllBoardConfigsOrThrow`
 * throws rather than degrading, and a catalogue blip is not evidence that a
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
    return view === null || view.hasCrawlableClimb;
  } catch {
    return true;
  }
}
