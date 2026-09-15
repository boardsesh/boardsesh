// The wall as the EDITOR sees it: one named version, usually a draft (#5441).
//
// Every other spray surface reads the published generation, which is what
// `ensureSprayWallLoaded` fetches and what the registry normally holds. The
// editor cannot: holds are only writable on a draft, and a draft has its own
// photograph and therefore its own photo→canonical homography. Seeding the
// editor from the published payload would show none of the work a previous
// session already saved to the draft, and would map every hold drawn on one
// photograph through a matrix solved for another.
//
// So this hook asks for the version by NUMBER — `sprayWallRenderData(uuid,
// version)` takes one — and then puts that payload in the registry under the
// wall's layout id, using the loader's own `registerRenderData`. Registering
// rather than keeping it private is the point: `InteractiveFilterBoard` draws
// the wall through `getBoardRenderData`, which reads the registry synchronously
// and has no way to be handed a payload. With the draft registered, the board
// under the editor IS the draft's photograph.
//
// The registry keys every cache on the version (`sprayCacheToken`), and a draft's
// number is one past the published one, so nothing the draft writes can be served
// back for the published wall. On unmount the published generation is pulled back
// in with `refreshSprayWall`, so a surface that outlives the editor is not left
// drawing an unpublished photo.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GET_SPRAY_WALL_RENDER_DATA } from '@boardsesh/graphql/operations/spray-walls';
import type { SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';
import { getHttpClient } from '../graphql/client';
import { registerRenderData } from './spray-wall-loader';
import { refreshSprayWall } from './spray-wall-registry';

type SprayWallRenderDataResponse = { sprayWallRenderData: SprayWallRenderData | null };

export const sprayWallDraftQueryKey = (wallUuid: string | null, versionNumber: number | null) =>
  ['sprayWallRenderData', wallUuid, versionNumber] as const;

/**
 * Short, and deliberately so. The payload carries a 15-minute presigned photo
 * signature, and an editing session is long — a wall corrected hold by hold is a
 * sitting, not a glance — so it is refetched well inside that window rather than
 * left to expire under the climber's hands.
 */
const DRAFT_STALE_TIME_MS = 5 * 60 * 1000;

export type UseSprayWallDraftResult = {
  /** Nothing has resolved yet. */
  isLoading: boolean;
  /**
   * The version resolved but cannot be edited: it does not exist, the viewer may
   * not see it, its photo will not say its pixel size, or its homography has no
   * inverse.
   */
  isUnavailable: boolean;
  /** The version's row-major photo→canonical homography, or null. */
  homography: readonly number[] | null;
};

/**
 * Fetch one version of a wall and make it the version the render path draws.
 *
 * `versionNumber` is `SprayWallVersion.number` — 1-based and dense per wall —
 * not the `id` the mutations take. Both come off the same row; the editor needs
 * the id to write and the number to read.
 */
export function useSprayWallDraft(
  layoutId: number,
  wallUuid: string | null,
  versionNumber: number | null,
): UseSprayWallDraftResult {
  const query = useQuery({
    queryKey: sprayWallDraftQueryKey(wallUuid, versionNumber),
    queryFn: () =>
      getHttpClient().request<SprayWallRenderDataResponse>(GET_SPRAY_WALL_RENDER_DATA, {
        uuid: wallUuid,
        version: versionNumber,
      }),
    select: (response) => response.sprayWallRenderData,
    enabled: wallUuid != null && versionNumber != null,
    staleTime: DRAFT_STALE_TIME_MS,
  });

  const renderData = query.data ?? null;
  const [registered, setRegistered] = useState(false);

  useEffect(() => {
    if (!renderData) return;
    // `registerRenderData` answers false for a payload that cannot be drawn — no
    // readable photo size, or a homography with no inverse — which is exactly
    // the "cannot be edited" the screen shows in words.
    setRegistered(registerRenderData(layoutId, renderData));
  }, [layoutId, renderData]);

  useEffect(
    () => () => {
      // Put the published generation back for whatever outlives this screen. A
      // no-op when the wall was never registered, and cheap when it was: the
      // published payload is almost always still in React Query's cache.
      refreshSprayWall(layoutId);
    },
    [layoutId],
  );

  return {
    isLoading: query.isPending && wallUuid != null && versionNumber != null,
    isUnavailable: !query.isPending && wallUuid != null && versionNumber != null && !registered,
    homography: renderData?.homography ?? null,
  };
}
