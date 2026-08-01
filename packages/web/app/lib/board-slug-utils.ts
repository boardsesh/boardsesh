import 'server-only';
import { cache } from 'react';
import type { ParsedBoardRouteParameters, BoardName } from '@/app/lib/types';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
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
  isOwned: boolean;
  ownerId: string;
  angle: number;
  isAngleAdjustable: boolean;
};

/**
 * Resolve a board entity by its slug.
 * Uses React cache() to deduplicate within a single server request.
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
        isOwned
        angle
        isAngleAdjustable
      }
    }
  `;

  try {
    const authToken = await getServerAuthToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    // Authenticated responses can contain private boards, so they must never
    // enter the shared data cache. Anonymous responses remain safely reusable.
    const cacheOptions = authToken ? { cache: 'no-store' as const } : { next: { revalidate: 300 } };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables: { slug } }),
      ...cacheOptions,
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
