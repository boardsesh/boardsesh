import { cache } from 'react';
import type { ParsedBoardRouteParameters, BoardName } from '@/app/lib/types';
import { getGraphQLHttpUrl } from '@/app/lib/graphql/client';

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
 */
export const resolveBoardBySlug = cache(async (slug: string): Promise<ResolvedBoard | null> => {
  const url = getGraphQLHttpUrl();
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { slug } }),
      next: { revalidate: 300 }, // Cache for 5 minutes
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
