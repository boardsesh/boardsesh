import 'server-only';
import { cache } from 'react';
import { GET_SPRAY_WALL_RENDER_DATA } from '@boardsesh/graphql/operations';
import { getGraphQLHttpUrl } from '@/app/lib/graphql/client';
import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';
import type { SprayWallHoldGeometry } from './spray-climb-view';

/**
 * The wall behind a spray climb page, read anonymously.
 *
 * Anonymously on purpose. www serves a wall in exactly two states — public, and
 * unlisted for somebody holding the link — and neither needs a viewer. Sending
 * a token would put an owner's private wall into a response the page then has
 * to decide not to render, and it would split the fetch cache per user for a
 * page that is otherwise the same bytes for everybody.
 *
 * The visibility decision is made BEFORE this runs, from the board row the slug
 * resolved to, so a private wall costs no round trip at all and the backend is
 * never asked a question whose answer would confirm the wall exists.
 */

export type SprayWallPageData = {
  versionNumber: number;
  /** The canonical frame the hold coordinates below live in. */
  boardWidth: number;
  boardHeight: number;
  photo: {
    /** Short-lived presigned URL over the PRIVATE bucket. Never persist it. */
    url: string;
    width: number | null;
    height: number | null;
  };
  /** Row-major 3x3 photo -> canonical. Null means treat it as the identity. */
  homography: number[] | null;
  holds: SprayWallHoldGeometry[];
  wall: {
    uuid: string;
    layoutId: number;
    holdCount: number;
    /** Stable, unsigned URL over the public copy. Null unless the wall is public. */
    publicPhotoUrl: string | null;
    name: string;
    angle: number;
    gymUuid: string | null;
    gymName: string | null;
    ownerDisplayName: string | null;
  };
};

type SprayWallRenderDataResponse = {
  sprayWallRenderData: {
    versionNumber: number;
    boardWidth: number;
    boardHeight: number;
    homography: number[] | null;
    photo: { url: string; width: number | null; height: number | null };
    holds: (SprayWallHoldGeometry & { removedVersion: number | null })[];
    wall: {
      uuid: string;
      layoutId: number;
      holdCount: number;
      publicPhotoUrl: string | null;
      board: {
        name: string;
        angle: number;
        gymUuid: string | null;
        gymName: string | null;
        ownerDisplayName: string | null;
      };
    };
  } | null;
};

/**
 * `null` means one thing only: the backend answered cleanly and there is no
 * wall to render — no such wall, soft-deleted, or nothing published yet. Every
 * failure throws, so the route answers 5xx and a crawler keeps the page.
 *
 * Same contract, and the same reasoning, as `resolveBoardBySlug`: swallowing a
 * wedged backend into `null` would put a 404 on an indexed URL, and 404 is a
 * status CDNs cache while a 5xx is not.
 */
export const fetchSprayWallPageData = cache(async (wallUuid: string): Promise<SprayWallPageData | null> => {
  const response = await fetch(getGraphQLHttpUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: GET_SPRAY_WALL_RENDER_DATA, variables: { uuid: wallUuid } }),
    signal: AbortSignal.timeout(SSR_BACKEND_FETCH_TIMEOUT_MS),
    // The photo URL inside is a 15-minute presigned signature, so a cached
    // response outlives the link it carries. Five minutes keeps the SSR read
    // cheap under a crawl burst and still hands every reader a live signature.
    next: { revalidate: 300 },
  });

  if (!response.ok) {
    throw new Error(`[spray] sprayWallRenderData for "${wallUuid}" failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { data?: SprayWallRenderDataResponse | null; errors?: unknown[] };

  // A 200 carrying `errors` is what a backend read deadline looks like, and
  // `data` is null beside it — indistinguishable from a real miss without this.
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`[spray] sprayWallRenderData for "${wallUuid}" returned GraphQL errors`);
  }

  const renderData = payload.data?.sprayWallRenderData;
  if (!renderData) return null;

  return {
    versionNumber: renderData.versionNumber,
    boardWidth: renderData.boardWidth,
    boardHeight: renderData.boardHeight,
    photo: renderData.photo,
    homography: renderData.homography,
    holds: renderData.holds.map((hold) => ({
      id: hold.id,
      cx: hold.cx,
      cy: hold.cy,
      r: hold.r,
      outline: hold.outline,
    })),
    wall: {
      uuid: renderData.wall.uuid,
      layoutId: renderData.wall.layoutId,
      holdCount: renderData.wall.holdCount,
      publicPhotoUrl: renderData.wall.publicPhotoUrl,
      name: renderData.wall.board.name,
      angle: renderData.wall.board.angle,
      gymUuid: renderData.wall.board.gymUuid,
      gymName: renderData.wall.board.gymName,
      ownerDisplayName: renderData.wall.board.ownerDisplayName,
    },
  };
});

/**
 * Which photograph the page shows, and it is a visibility decision rather than
 * a preference.
 *
 * A PUBLIC wall shows the copy SW-14 makes in the world-readable bucket: a
 * stable URL a crawler, an unfurler and a CDN can all hold.
 *
 * An UNLISTED wall has no such copy by design — it is read through
 * fifteen-minute presigned URLs over the private bucket — and one of those must
 * never go into the page's HTML: a climb-view URL carries a 24-hour CDN
 * `s-maxage`, so the cached page would point at an expired signature for almost
 * all of that day. It gets a stable path instead, and
 * `/api/v1/spray-walls/{uuid}/photo` mints a fresh signature per image fetch.
 */
export function resolveSprayPhotoUrl(pageData: SprayWallPageData, isPublicWall: boolean): string | null {
  if (isPublicWall) return pageData.wall.publicPhotoUrl;
  if (!pageData.photo.url) return null;
  return `/api/v1/spray-walls/${encodeURIComponent(pageData.wall.uuid)}/photo`;
}
