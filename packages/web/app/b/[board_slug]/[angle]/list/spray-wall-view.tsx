import React from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import type { ResolvedBoard } from '@/app/lib/board-slug-utils';
import SprayWallFrontDoor from '@/app/components/spray-wall/spray-wall-front-door';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { createBoardContentPageMetadata } from '@/app/lib/seo/metadata';
import { resolveSprayWallVisibility } from '@/app/lib/spray/spray-visibility';
import { fetchSprayWallPageData, resolveSprayPhotoUrl } from '@/app/lib/spray/spray-wall-render-data.server';

/**
 * Redeeming a wall's share link on the web.
 *
 * `buildSprayWallShareUrl` (`packages/mobile/src/lib/spray/spray-share.ts`) sends
 * people here: `/b/{slug}/{angle}/list` for a public wall, and the same URL with
 * `?wall=<uuid>` when the wall is unlisted. Universal Links route it into the app
 * when the app is installed; this is what a browser gets.
 *
 * **`?wall=` is a capability, and it is checked as one.** The uuid has to be THIS
 * wall's uuid — the one the slug already resolved to — for exactly the reason
 * SW-14 pairs `sprayWallUuid` against the request's layout on a climb write:
 * without the pairing, one leaked uuid would open every wall in the sequence. A
 * mismatch is the same 404 as no param at all, so the response is never an oracle
 * for which slugs are unlisted walls.
 *
 * | The wall is | No `?wall=` | `?wall=` matches | `?wall=` is wrong |
 * | --- | --- | --- | --- |
 * | public | renders | renders | 404 |
 * | unlisted | 404 | renders | 404 |
 * | private | 404 | 404 | 404 |
 *
 * A public wall needs no capability and its share link carries none, which is why
 * it renders on the clean URL. A private wall refuses everyone, its owner
 * included: the app is where an owner reads their own wall, and www puts a shared
 * `s-maxage` on these paths with no session split.
 *
 * The page is always `noindex, follow` and emits no canonical. The URL that
 * matters for an unlisted wall carries a capability, and a canonical naming the
 * bare path would invite a crawler to a URL that answers 404 — so there is no
 * clean twin to point at, and the sitemap names none of this either (the boards
 * shard is catalogue-only).
 */

/** The share-link capability, as it appears in the query string. */
export const WALL_CAPABILITY_PARAM = 'wall';

export type SprayWallAccess = 'render' | 'refuse';

/**
 * Whether this request may see the wall, from the board row and the param alone.
 *
 * No round trip: a private wall is refused before anything asks the backend about
 * it, so the request never produces a signal that the wall exists.
 */
export function resolveSprayWallAccess(
  board: Pick<ResolvedBoard, 'uuid' | 'isPublic' | 'isUnlisted'>,
  wallParam: string | string[] | undefined,
): SprayWallAccess {
  const visibility = resolveSprayWallVisibility(board);
  if (visibility === 'private') return 'refuse';
  if (visibility === 'public') {
    // A public wall is world-readable, so a param is not needed — but a WRONG one
    // is still refused rather than ignored, because a link carrying somebody
    // else's uuid is a mistake worth surfacing as "not here" instead of quietly
    // showing a different wall than the sender meant.
    return wallParam === undefined || wallParam === board.uuid ? 'render' : 'refuse';
  }
  return wallParam === board.uuid ? 'render' : 'refuse';
}

/** `generateMetadata` for the spray branch of `/b/{slug}/{angle}/list`. */
export async function buildSprayWallListMetadata(board: ResolvedBoard): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('climbs');

  return createBoardContentPageMetadata({
    title: t('spray.wall.metadata.title', { wallName: board.name }),
    description: t('spray.wall.metadata.description', { wallName: board.name, angle: board.angle }),
    locale,
    // Always, for every wall. See the docblock above: the URL a shared wall is
    // read at carries a capability, so there is no clean twin to canonicalise to.
    robots: { index: false, follow: true },
  });
}

/** The page body for the spray branch. Throws Next's 404 for anything refused. */
export default async function SprayWallListPage({
  board,
  wallParam,
}: {
  board: ResolvedBoard;
  wallParam: string | string[] | undefined;
}) {
  if (resolveSprayWallAccess(board, wallParam) === 'refuse') notFound();

  const wallData = await fetchSprayWallPageData(board.uuid);
  // Null here is a wall the backend will not hand over — soft-deleted, or with
  // nothing published yet. Same answer as a refused capability.
  if (!wallData) notFound();

  return (
    <SprayWallFrontDoor
      wallData={wallData}
      photoUrl={resolveSprayPhotoUrl(wallData, board.isPublic)}
      angle={board.angle}
    />
  );
}
