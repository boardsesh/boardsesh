// Anonymous, request-deduped (React cache) server fetchers for the /embed/**
// widgets. Mirrors `fetchGymKiosk` in kiosk-page-renderer.tsx: plain HTTP
// GraphQL with NO auth header — embeds are display-only, cookieless surfaces,
// and everything they show must be resolvable anonymously.
//
// Transient-vs-null discrimination (same contract as fetchGymKiosk): a failed
// transport, HTTP error, or GraphQL resolver error is `{ status: 'error' }` —
// the page renders the self-healing retry screen, because an embed on a gym's
// website is as unattended as a TV and must not brick on a backend blip. Only
// a SUCCESSFUL response resolving the entity to null means "doesn't exist /
// not visible" — that (and the page's own isPublic gates) is what notFound()s.
//
// revalidate 300: embeds are pasted into gym CMS pages and fetched by every
// visitor — a 5-minute shared cache keeps the load rate-limit friendly while
// board/gym config changes still land within minutes. Live climb data does NOT
// ride these fetches (the board embed's presence hub and the leaderboard's
// client refetch carry freshness).
//
// Deadline: an unbounded `await fetch` here is what turns a slow backend into a
// blank iframe. Node's fetch has no default timeout, so a socket that is
// accepted and then never answered holds the render open indefinitely. With the
// signal the catch below maps the abort to 'error' and the widget paints its
// retry screen in seconds. See SSR_BACKEND_FETCH_TIMEOUT_MS for the value and
// for the one case Next will not let us bound.

import 'server-only';
import { cache } from 'react';
import {
  GET_BOARD,
  GET_GYM,
  GET_GYM_BOARDS,
  type GetBoardQueryResponse,
  type GetGymBoardsQueryResponse,
  type GetGymQueryResponse,
} from '@boardsesh/graphql/operations';
import type { Gym, UserBoard } from '@boardsesh/shared-schema';
import { getGraphQLHttpUrl } from '@/app/lib/graphql/client';
import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';

const EMBED_REVALIDATE_SECONDS = 300;

export type EmbedFetchResult<Entity> = { status: 'ok'; entity: Entity } | { status: 'error' };

/**
 * One anonymous GraphQL query; `readEntity` picks the entity off the response
 * data. `undefined` from the picker means the field itself was missing —
 * that's a malformed/errored response, not a null entity, so it maps to
 * 'error' alongside any GraphQL errors.
 */
async function fetchEmbedGraphQL<ResponseData, Entity>(
  query: string,
  variables: Record<string, string>,
  readEntity: (responseData: ResponseData) => Entity | undefined,
): Promise<EmbedFetchResult<Entity>> {
  try {
    const response = await fetch(getGraphQLHttpUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(SSR_BACKEND_FETCH_TIMEOUT_MS),
      next: { revalidate: EMBED_REVALIDATE_SECONDS },
    });
    if (!response.ok) return { status: 'error' };
    const payload = (await response.json()) as { data?: ResponseData | null; errors?: unknown[] };
    if (payload.data === undefined || payload.data === null || (payload.errors?.length ?? 0) > 0) {
      return { status: 'error' };
    }
    const entity = readEntity(payload.data);
    if (entity === undefined) return { status: 'error' };
    return { status: 'ok', entity };
  } catch {
    return { status: 'error' };
  }
}

/** The raw board (null = doesn't exist) — the CALLER must gate visibility via
 * `resolveEmbeddableBoard` (the resolver serves private boards to anon). */
export const fetchBoardForEmbed = cache(async (boardUuid: string): Promise<EmbedFetchResult<UserBoard | null>> => {
  return fetchEmbedGraphQL<GetBoardQueryResponse, UserBoard | null>(
    GET_BOARD,
    { boardUuid },
    (responseData) => responseData.board,
  );
});

/** The raw gym (null = doesn't exist) — the CALLER must gate visibility via
 * `resolveEmbedBrandGym` (the resolver serves private gyms to anon). */
export const fetchGymForEmbed = cache(async (gymUuid: string): Promise<EmbedFetchResult<Gym | null>> => {
  return fetchEmbedGraphQL<GetGymQueryResponse, Gym | null>(GET_GYM, { gymUuid }, (responseData) => responseData.gym);
});

/**
 * The gym's boards as the anonymous viewer sees them — the backend restricts
 * this to public, LISTED boards. NOTE: `gymBoards` masks a private/missing gym
 * as a GraphQL NOT_FOUND error, which lands in 'error' here; callers gate on
 * the public gym FIRST (fetchGymForEmbed + resolveEmbedBrandGym), so by the
 * time this runs an error really is transient (or a just-flipped-private gym,
 * where a retry screen that heals when the 5-min cache rolls is acceptable).
 */
export const fetchGymBoardsForEmbed = cache(async (gymUuid: string): Promise<EmbedFetchResult<UserBoard[]>> => {
  return fetchEmbedGraphQL<GetGymBoardsQueryResponse, UserBoard[]>(
    GET_GYM_BOARDS,
    { gymUuid },
    (responseData) => responseData.gymBoards,
  );
});
