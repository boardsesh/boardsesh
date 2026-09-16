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
// in through `invalidateSprayWallRenderData` — the SW-07 seam for "this device
// changed this wall" — so a surface that outlives the editor is neither left
// drawing an unpublished photo nor served a cached payload from before the
// session.
//
// That seam is deliberately NOT what a hold save calls. It re-registers the
// PUBLISHED version, which is exactly wrong while the editor is holding the
// draft: a save would put the published wall back under the climber's hands
// mid-session. A hold save changes the draft and only the draft, so it
// invalidates the draft's own key (see `use-spray-hold-writes.ts`) and the
// published generation waits for the editor to close.

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GET_SPRAY_WALL_RENDER_DATA } from '@boardsesh/graphql/operations/spray-walls';
import type { SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';
import { getHttpClient } from '../graphql/client';
import { invalidateSprayWallRenderData, registerRenderData } from './spray-wall-loader';

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

  /**
   * The verdict on one payload: which payload it was about, and whether the
   * registry took it.
   *
   * Keyed on the payload rather than a bare boolean because the two failures it
   * has to tell apart look identical to a boolean. "Not registered" means either
   * "the effect has not run yet" — one render, on the frame the data lands — or
   * "this payload cannot be drawn at all". Reporting the first as unavailable
   * flashes a "this wall has no photo" screen for a frame before the editor
   * appears; reporting the second as loading hangs a spinner forever.
   */
  const [verdict, setVerdict] = useState<{ payload: SprayWallRenderData; ok: boolean } | null>(null);

  useEffect(() => {
    if (!renderData) return;
    // `registerRenderData` answers false for a payload that cannot be drawn — no
    // readable photo size, or a homography with no inverse — which is exactly
    // the "cannot be edited" the screen shows in words.
    setVerdict({ payload: renderData, ok: registerRenderData(layoutId, renderData) });
  }, [layoutId, renderData]);

  // Captured in a ref so the teardown does not re-run — and therefore does not
  // yank the published wall back mid-session — when the uuid prop settles.
  const queryClient = useQueryClient();
  const teardownRef = useRef({ queryClient, wallUuid });
  teardownRef.current = { queryClient, wallUuid };

  useEffect(
    () => () => {
      // Put the published generation back for whatever outlives this screen, and
      // drop the cached payload with it: this device has been writing to the
      // wall, so a payload from before the session is not to be trusted.
      const { queryClient: client, wallUuid: uuid } = teardownRef.current;
      if (!uuid) return;
      void invalidateSprayWallRenderData(client, uuid, layoutId);
    },
    [layoutId],
  );

  const asked = wallUuid != null && versionNumber != null;
  // A payload in hand that has not been ruled on yet is still loading, not
  // unavailable — that is the one-frame flash.
  const awaitingVerdict = renderData != null && verdict?.payload !== renderData;

  return {
    isLoading: asked && (query.isPending || awaitingVerdict),
    isUnavailable: asked && !query.isPending && !awaitingVerdict && !(verdict?.ok ?? false),
    homography: renderData?.homography ?? null,
  };
}
