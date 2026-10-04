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

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { GET_SPRAY_WALL_RENDER_DATA } from '@boardsesh/graphql/operations/spray-walls';
import type { SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';
import { getHttpClient } from '../graphql/client';
import { retryConnectivityNow } from '../connectivity/connectivity-store';
import { invalidateSprayWallRenderData, registerRenderData } from './spray-wall-loader';
import {
  getSprayWall,
  sprayWallRemovalGeneration,
  sprayWallViewerGeneration,
  subscribeToSprayWalls,
} from './spray-wall-registry';

type SprayWallRenderDataResponse = { sprayWallRenderData: SprayWallRenderData | null };

/**
 * The viewer generation each draft payload was fetched under, noted before its
 * request left. Kept beside the payload rather than in it so the cached shape
 * stays the server's, and weakly, so it goes when the payload does.
 *
 * The payload carries `wall.viewerCanEdit`, and the registry only believes that
 * from a registration that can say which account it was read for. Without this
 * the wall's own owner reads as "cannot edit" for as long as the editor's draft
 * is the registered version.
 */
const draftViewerGenerations = new WeakMap<SprayWallRenderData, number>();
const draftRemovalGenerations = new WeakMap<SprayWallRenderData, number>();

export const sprayWallDraftQueryKey = (wallUuid: string | null, versionNumber: number | null) =>
  ['sprayWallRenderData', wallUuid, versionNumber] as const;

/**
 * Short, and deliberately so. The payload carries a 15-minute presigned photo
 * signature, and an editing session is long — a wall corrected hold by hold is a
 * sitting, not a glance — so it is refetched well inside that window rather than
 * left to expire under the climber's hands.
 */
const DRAFT_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * Read one version's payload, noting which viewer and which removal generation
 * it was read under.
 *
 * One function for the hook and for `prefetchSprayWallDraft`, so a prefetched
 * payload carries the same notes a mounted read does.
 */
async function fetchSprayWallDraft(layoutId: number, wallUuid: string | null, versionNumber: number | null) {
  const viewerGeneration = sprayWallViewerGeneration();
  const removalGeneration = sprayWallRemovalGeneration(layoutId);
  const response = await getHttpClient().request<SprayWallRenderDataResponse>(GET_SPRAY_WALL_RENDER_DATA, {
    uuid: wallUuid,
    version: versionNumber,
  });
  if (response.sprayWallRenderData) {
    draftViewerGenerations.set(response.sprayWallRenderData, viewerGeneration);
    draftRemovalGenerations.set(response.sprayWallRenderData, removalGeneration);
  }
  return response;
}

/**
 * Start the draft's read before the editor mounts, so the editor usually opens
 * with its wall already in hand. The add-a-wall flow calls this while the
 * detector runs: the payload is the draft's photo, homography and saved holds,
 * none of which detection writes to.
 *
 * Never rejects. A read that fails here is simply read again by the editor.
 */
export function prefetchSprayWallDraft(
  queryClient: QueryClient,
  layoutId: number,
  wallUuid: string,
  versionNumber: number,
): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: sprayWallDraftQueryKey(wallUuid, versionNumber),
    queryFn: () => fetchSprayWallDraft(layoutId, wallUuid, versionNumber),
    staleTime: DRAFT_STALE_TIME_MS,
  });
}

export type UseSprayWallDraftResult = {
  /** Nothing has resolved yet. */
  isLoading: boolean;
  /**
   * There is no payload and nothing is fetching one: the read gave up, or its
   * retry is parked until the phone is back online. The screen says so and
   * offers `retry` rather than leaving a spinner over a request that is not
   * running. An automatic retry that is still in flight is NOT stalled — one
   * dropped request must not flash an error ahead of the editor.
   */
  isStalled: boolean;
  /**
   * Read the version again now. Asks the connectivity store to re-probe first:
   * while it reads as offline every request is refused before it reaches the
   * network, so a refetch alone could never succeed.
   */
  retry: () => void;
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
    queryFn: () => fetchSprayWallDraft(layoutId, wallUuid, versionNumber),
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
    setVerdict({
      payload: renderData,
      ok: registerRenderData(
        layoutId,
        renderData,
        undefined,
        draftViewerGenerations.get(renderData),
        draftRemovalGenerations.get(renderData),
      ),
    });
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

  const isLoading = asked && (query.isPending || awaitingVerdict);
  const isUnavailable = asked && !query.isPending && !awaitingVerdict && !(verdict?.ok ?? false);
  // True from the retry tap until its read has started, so the tap is answered
  // with the loading line while the connectivity probe is still out.
  const [retrying, setRetrying] = useState(false);
  // `paused` is a retry parked because the phone reads as offline; `isError` is
  // a read that gave up. A retry that is backing off or running is neither.
  const isStalled = asked && !retrying && query.data === undefined && (query.fetchStatus === 'paused' || query.isError);
  const homography = renderData?.homography ?? null;

  const { refetch } = query;
  const retry = useCallback(() => {
    setRetrying(true);
    void retryConnectivityNow()
      // An inconclusive or failed probe still gets the read: the request itself
      // is the next best sample.
      .catch(() => undefined)
      // `refetch` hands back a parked read as it is, so that one is cancelled
      // first and the new read starts from its first attempt.
      .then(() => queryClient.cancelQueries({ queryKey: sprayWallDraftQueryKey(wallUuid, versionNumber) }))
      .then(() => {
        setRetrying(false);
        return refetch();
      });
  }, [queryClient, wallUuid, versionNumber, refetch]);

  return useMemo(
    () => ({ isLoading, isUnavailable, isStalled, retry, homography }),
    [isLoading, isUnavailable, isStalled, retry, homography],
  );
}

/**
 * Put the draft back in the registry whenever something else takes it out, for
 * as long as the caller is mounted.
 *
 * `useSprayWallDraft` registers a payload once, when it lands. That is enough
 * for the editor, but not for a screen that mounts right AFTER another
 * `useSprayWallDraft` instance unmounted: that instance's teardown forces a
 * reload of the PUBLISHED wall (`invalidateSprayWallRenderData`), and on a wall
 * that has never been published that reload resolves to nothing and
 * unregisters it — after this screen's own registration, since it is async. The
 * draft would vanish from under a screen that is still drawing it.
 *
 * Re-registers from the draft query's cached payload, so it costs no request.
 * Runs only when the registered version of THIS wall changes, and settles as
 * soon as it is the draft's again. A payload that cannot be drawn is refused by
 * `registerRenderData`, the registry does not change, and nothing re-runs it
 * until something else registers or drops the wall.
 */
export function useKeepSprayDraftRegistered(
  layoutId: number,
  wallUuid: string | null,
  versionNumber: number | null,
): void {
  const queryClient = useQueryClient();
  const registeredVersion = useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(() => getSprayWall(layoutId)?.version ?? null, [layoutId]),
  );

  useEffect(() => {
    if (wallUuid == null || versionNumber == null) return;
    if (registeredVersion === versionNumber) return;
    const cached = queryClient.getQueryData<SprayWallRenderDataResponse>(
      sprayWallDraftQueryKey(wallUuid, versionNumber),
    );
    const payload = cached?.sprayWallRenderData;
    if (!payload) return;
    registerRenderData(
      layoutId,
      payload,
      undefined,
      draftViewerGenerations.get(payload),
      draftRemovalGenerations.get(payload),
    );
  }, [layoutId, wallUuid, versionNumber, registeredVersion, queryClient]);
}
