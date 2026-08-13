import { generateSetNameSlug } from '@boardsesh/play-view/readable-url-utils';

/**
 * Whether a set name is one of the sets a URL's set slug selects.
 *
 * Delegates to the shared `generateSetNameSlug` — the very function the URL
 * *builders* use — so the two directions cannot drift. A hand-mirrored copy of
 * the aux/main/kicker/bolt/screw heuristics here would agree today and light
 * different holds than the Expo app the first time either side is tweaked.
 *
 * @param setName - The name of the set from the database
 * @param slugParts - Slug parts split off the URL segment (e.g. ['main-kicker', 'main', 'aux-kicker', 'aux'])
 * @returns true if the set name slugifies to any of the slug parts
 */
export const matchSetNameToSlugParts = (setName: string, slugParts: string[]): boolean =>
  slugParts.includes(generateSetNameSlug(setName));
