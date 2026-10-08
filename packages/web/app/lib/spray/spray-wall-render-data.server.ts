import 'server-only';
import { cache } from 'react';
import {
  GET_SPRAY_WALL,
  GET_SPRAY_WALL_ART,
  GET_SPRAY_WALL_LOOK,
  GET_SPRAY_WALL_RENDER_DATA,
} from '@boardsesh/graphql/operations';
import { getGraphQLHttpUrl } from '@/app/lib/graphql/client';
import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';
import type { SprayWallArtChoice, SprayWallHoldGeometry } from './spray-climb-view';
import { webClientIdentityHeaders } from '@/app/lib/client-identity';

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
 * One anonymous read against the wall API, with the deadline and the cache
 * window both callers below want.
 *
 * Five minutes on the fetch cache: the presigned photo URL inside lives fifteen,
 * so this keeps the read cheap under a crawl burst and still hands every reader a
 * signature with time left on it.
 */
async function readSprayWallQuery<TData>(
  query: string,
  wallUuid: string,
  operation: string,
  extraVariables: Record<string, unknown> = {},
): Promise<TData | null> {
  const response = await fetch(getGraphQLHttpUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...webClientIdentityHeaders() },
    body: JSON.stringify({ query, variables: { uuid: wallUuid, ...extraVariables } }),
    signal: AbortSignal.timeout(SSR_BACKEND_FETCH_TIMEOUT_MS),
    next: { revalidate: 300 },
  });

  if (!response.ok) {
    throw new Error(`[spray] ${operation} for "${wallUuid}" failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { data?: TData | null; errors?: unknown[] };

  // A 200 carrying `errors` is what a backend read deadline looks like, and
  // `data` is null beside it — indistinguishable from a real miss without this.
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`[spray] ${operation} for "${wallUuid}" returned GraphQL errors`);
  }

  return payload.data ?? null;
}

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
  const data = await readSprayWallQuery<SprayWallRenderDataResponse>(
    GET_SPRAY_WALL_RENDER_DATA,
    wallUuid,
    'sprayWallRenderData',
  );
  const renderData = data?.sprayWallRenderData;
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

type SprayWallPhotoResponse = {
  sprayWall: { currentVersion: { photo: { url: string } | null } | null } | null;
};

/**
 * Just the presigned photo URL of a wall's published version.
 *
 * `sprayWall` rather than `sprayWallRenderData`, because the photo redirect route
 * runs once per image fetch and needs nothing else: the render payload carries
 * every alive hold, which is up to 1,500 rows of geometry per request for a
 * caller that is about to throw all of it away.
 *
 * Same gate either way — both resolvers apply the wall view rule, and this read
 * is anonymous, so a private wall comes back null and the route 404s.
 */
export async function fetchSprayWallPhotoUrl(wallUuid: string): Promise<string | null> {
  const data = await readSprayWallQuery<SprayWallPhotoResponse>(GET_SPRAY_WALL, wallUuid, 'sprayWall');
  return data?.sprayWall?.currentVersion?.photo?.url ?? null;
}

type SprayWallLookResponse = { sprayWall: { renderSettings: { background?: unknown } | null } | null };

type SprayWallArtResponse = {
  sprayWallArt: {
    versionNumber: number;
    status: string;
    width: number | null;
    height: number | null;
    crop: { url: string } | null;
    cutout: { url: string } | null;
  } | null;
};

type GeneratedBackground = SprayWallArtChoice['background'];

function generatedBackground(value: unknown): GeneratedBackground | null {
  return value === 'wall-crop' || value === 'hold-cutouts' ? value : null;
}

/**
 * The owner's generated wall look for the version the page draws, or null to
 * draw the photograph.
 *
 * Null for every miss and every failure, never a throw: the photo is always a
 * correct picture of the wall, so a backend that predates `sprayWallArt`, art
 * that is still rendering, or art for a different version than the render
 * payload's (the two reads are cached separately) all fall back to it.
 */
export const fetchSprayWallArtChoice = cache(
  async (wallUuid: string, versionNumber: number): Promise<SprayWallArtChoice | null> => {
    try {
      const look = await readSprayWallQuery<SprayWallLookResponse>(GET_SPRAY_WALL_LOOK, wallUuid, 'sprayWall look');
      const background = generatedBackground(look?.sprayWall?.renderSettings?.background);
      if (!background) return null;

      const data = await readSprayWallQuery<SprayWallArtResponse>(GET_SPRAY_WALL_ART, wallUuid, 'sprayWallArt', {
        version: versionNumber,
      });
      const art = data?.sprayWallArt;
      if (!art || art.status !== 'READY' || art.versionNumber !== versionNumber || !art.width || !art.height) {
        return null;
      }
      return { background, width: art.width, height: art.height };
    } catch (error) {
      console.warn('[spray] wall art read failed; drawing the photo instead:', error);
      return null;
    }
  },
);

/**
 * The stable path a page embeds for a wall's generated look. Like the unlisted
 * photo, the art lives in the PRIVATE bucket behind fifteen-minute signatures,
 * so the HTML carries this path and the route mints a fresh one per fetch. The
 * same for a public wall: there is no public copy of the art.
 */
export function resolveSprayArtUrl(wallUuid: string, art: SprayWallArtChoice | null): string | null {
  if (!art) return null;
  return `/api/v1/spray-walls/${encodeURIComponent(wallUuid)}/photo?look=${art.background}`;
}

/**
 * The presigned URL of one generated look of a wall's published version, or
 * null when it is not ready (or the wall is not readable anonymously).
 */
export async function fetchSprayWallArtImageUrl(wallUuid: string, look: GeneratedBackground): Promise<string | null> {
  const data = await readSprayWallQuery<SprayWallArtResponse>(GET_SPRAY_WALL_ART, wallUuid, 'sprayWallArt');
  const art = data?.sprayWallArt;
  if (!art || art.status !== 'READY') return null;
  return (look === 'wall-crop' ? art.crop?.url : art.cutout?.url) ?? null;
}
