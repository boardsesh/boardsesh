import { cache } from 'react';
import type { ParsedBoardRouteParameters, BoardName } from '@/app/lib/types';
import { getGraphQLHttpUrl } from '@/app/lib/graphql/client';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';

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
 * The viewer's session token is forwarded so the backend can apply its own
 * read mask: `boardBySlug` returns null for a private board unless the caller
 * owns it or runs its linked gym. Sending the request anonymously would hide
 * every private board from its own owner, so pages must not assume this is an
 * anonymous read.
 */
export const resolveBoardBySlug = cache(async (slug: string): Promise<ResolvedBoard | null> => {
  const url = getGraphQLHttpUrl();
  const authToken = await getServerAuthToken();
  const query = `
    query BoardBySlug($slug: String!) {
      boardBySlug(slug: $slug) {
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
      }
    }
  `;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ query, variables: { slug } }),
      // Only the anonymous answer is shareable between viewers. An
      // authenticated one can carry a private board plus per-viewer fields
      // (isOwned), so it must never land in the cross-user data cache.
      ...(authToken ? { cache: 'no-store' as const } : { next: { revalidate: 300 } }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data?.data?.boardBySlug ?? null;
  } catch {
    return null;
  }
});

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
