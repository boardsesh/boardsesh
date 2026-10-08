import 'server-only';
import { cache } from 'react';
import type { ParsedBoardRouteParameters, BoardName } from '@/app/lib/types';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { getGraphQLHttpUrl } from '@/app/lib/graphql/client';
import { webClientIdentityHeaders } from '@/app/lib/client-identity';
import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';
import { parseBoardAngleSegment, toBoardName } from '@boardsesh/board-config';

export type ResolvedBoard = {
  uuid: string;
  slug: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  name: string;
  description?: string | null;
  locationName?: string | null;
  isPublic: boolean;
  // Link-only: reachable anonymously (when isPublic) but excluded from
  // search/browse and, per this fix, from crawler indexing (noindex,follow).
  isUnlisted: boolean;
  isOwned: boolean;
  ownerId: string;
  angle: number;
  isAngleAdjustable: boolean;
};

/**
 * Resolve a board entity by its slug.
 * Uses React cache() to deduplicate within a single server request.
 *
 * This read is anonymous, and its result lands in a cross-user data cache, so
 * treat every field it returns as disclosable to whoever holds the slug. That
 * is what #4087 changes: it forwards the viewer's token and splits the cache so
 * `boardBySlug` can mask a private board. Until it lands, `isPublic` here is
 * only good enough to drive `noindex` — never to decide what a page renders.
 *
 * `null` means one thing only: the backend answered cleanly and there is no such
 * board (or it is masked from this viewer). Every failure — a rejected fetch, a
 * non-2xx, a 200 carrying GraphQL `errors` — throws, because every caller turns
 * `null` into `notFound()`. Swallowing a wedged backend into `null` put a 404 on
 * `/b/{slug}/{angle}/list` and `/b/{slug}/{angle}/view/{uuid}`, and 404 is on
 * Vercel's cacheable-status list — one blip pinned a cached 404 on an indexed
 * front door for the length of its `s-maxage` (24 h on lists). A 5xx is never
 * CDN-cached, and Google retries it and keeps the URL.
 *
 * "Every failure throws" only works if every failure eventually happens, which
 * is what SSR_BACKEND_FETCH_TIMEOUT_MS buys: a backend that accepts the socket
 * and never answers is otherwise not a failure at all, just a render that never
 * finishes.
 */
export const resolveBoardBySlug = cache(async (slug: string, wallUuid?: string): Promise<ResolvedBoard | null> => {
  if (wallUuid === undefined) return fetchBoardBySlug(slug, undefined);
  try {
    return await fetchBoardBySlug(slug, wallUuid);
  } catch (error) {
    // The deploy window where www is ahead of the backend: an older schema has no
    // `wallUuid` argument and rejects the whole document. Ask again without it, so
    // the request gets exactly what it got before this argument existed (an
    // unlisted wall is a 404, everything else renders) instead of a 500.
    if (error instanceof UnknownWallUuidArgumentError) return fetchBoardBySlug(slug, undefined);
    throw error;
  }
});

class UnknownWallUuidArgumentError extends Error {}

const BOARD_BY_SLUG_FIELDS = `
        uuid
        slug
        ownerId
        boardType
        layoutId
        sizeId
        setIds
        name
        description
        locationName
        isPublic
        isUnlisted
        isOwned
        angle
        isAngleAdjustable
`;

/**
 * `wallUuid` is a spray wall's share-link capability (`?wall=`). The backend
 * honours it only when it is the uuid of the wall the slug names, and only to
 * open an UNLISTED wall; it is sent only when the request carried one, so every
 * other lookup sends the same document, and hits the same cache entry, as before.
 */
async function fetchBoardBySlug(slug: string, wallUuid: string | undefined): Promise<ResolvedBoard | null> {
  const url = getGraphQLHttpUrl();
  const query =
    wallUuid === undefined
      ? `query BoardBySlug($slug: String!) { boardBySlug(slug: $slug) { ${BOARD_BY_SLUG_FIELDS} } }`
      : `query BoardBySlugWithWall($slug: String!, $wallUuid: ID) { boardBySlug(slug: $slug, wallUuid: $wallUuid) { ${BOARD_BY_SLUG_FIELDS} } }`;
  const variables = wallUuid === undefined ? { slug } : { slug, wallUuid };

  const authToken = await getServerAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...webClientIdentityHeaders() };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  // A public board can become private between requests, including anonymous reads.
  const cacheOptions = { cache: 'no-store' as const };

  // An abort lands in the same bucket as a rejected fetch: it throws, so
  // `/b/{slug}` answers 5xx (retried by crawlers, never CDN-cached) instead of
  // holding the connection open for as long as the backend cares to stall.
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(SSR_BACKEND_FETCH_TIMEOUT_MS),
    ...cacheOptions,
  });

  if (!response.ok) {
    throw new Error(`[board-slug] boardBySlug lookup for "${slug}" failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: { boardBySlug?: ResolvedBoard | null } | null;
    errors?: unknown[];
  };

  // A 200 carrying `errors` is the shape a backend read deadline produces, and
  // `data.boardBySlug` is `null` alongside it — indistinguishable from a real
  // miss unless we look at `errors`.
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    if (wallUuid !== undefined && payload.errors.some(isUnknownWallUuidArgument)) {
      throw new UnknownWallUuidArgumentError(`[board-slug] backend has no boardBySlug(wallUuid:) yet`);
    }
    throw new Error(`[board-slug] boardBySlug lookup for "${slug}" returned GraphQL errors`);
  }

  return payload.data?.boardBySlug ?? null;
}

function isUnknownWallUuidArgument(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('message' in error)) return false;
  const { message } = error;
  return typeof message === 'string' && message.includes('Unknown argument "wallUuid"');
}

/**
 * Convert a resolved board entity to ParsedBoardRouteParameters.
 */
export function boardToRouteParams(board: ResolvedBoard, angle: number): ParsedBoardRouteParameters {
  return {
    board_name: board.boardType as BoardName,
    layout_id: board.layoutId,
    size_id: board.sizeId,
    set_ids: board.setIds.split(',').map(Number),
    angle,
  };
}

/** Convert a `/b` angle segment only when it is canonical and supported. */
export function boardToRouteParamsFromAngleSegment(
  board: ResolvedBoard,
  angleSegment: string,
): ParsedBoardRouteParameters | null {
  const boardName = toBoardName(board.boardType);
  if (!boardName) return null;
  const angle = parseBoardAngleSegment(boardName, angleSegment);
  return angle === null ? null : boardToRouteParams(board, angle);
}
