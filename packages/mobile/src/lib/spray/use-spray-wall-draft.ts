// Draft geometry stays local to its editor. Only initial, unpublished walls
// register globally for the add-wall look carousel; published surfaces always
// retain their published photo and holds.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { GET_SPRAY_WALL_DRAFT_RENDER_DATA } from '@boardsesh/graphql/operations/spray-walls';
import type { SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';
import { getHttpClient } from '../graphql/client';
import { retryConnectivityNow } from '../connectivity/connectivity-store';
import { invalidateSprayWallRenderData, mapSprayWallRenderData } from './spray-wall-loader';
import {
  getSprayWall,
  registerSprayWall,
  type RegisteredSprayWall,
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

export const sprayWallDraftQueryKey = (
  wallUuid: string | null,
  versionNumber: number | null,
  versionId?: string | null,
) =>
  versionId === undefined
    ? (['sprayWallRenderData', wallUuid, versionNumber] as const)
    : (['sprayWallRenderData', wallUuid, versionNumber, versionId] as const);

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
  const response = await getHttpClient().request<SprayWallRenderDataResponse>(GET_SPRAY_WALL_DRAFT_RENDER_DATA, {
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
  versionId: string,
): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: sprayWallDraftQueryKey(wallUuid, versionNumber, versionId),
    queryFn: () => fetchSprayWallDraft(layoutId, wallUuid, versionNumber),
    staleTime: DRAFT_STALE_TIME_MS,
    structuralSharing: false,
  });
}

export type UseSprayWallDraftResult = {
  /** Mapped photo and holds owned by this draft surface. */
  wall: RegisteredSprayWall | null;
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
  versionId: string | null,
): UseSprayWallDraftResult {
  const query = useQuery({
    queryKey: sprayWallDraftQueryKey(wallUuid, versionNumber, versionId),
    queryFn: () => fetchSprayWallDraft(layoutId, wallUuid, versionNumber),
    select: (response) => response.sprayWallRenderData,
    enabled: wallUuid != null && versionNumber != null && versionId != null,
    staleTime: DRAFT_STALE_TIME_MS,
    structuralSharing: false,
  });

  const renderData = query.data ?? null;
  const accessGeneration = useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(() => `${sprayWallViewerGeneration()}:${sprayWallRemovalGeneration(layoutId)}`, [layoutId]),
  );

  const wall = useMemo(() => {
    void accessGeneration;
    if (!renderData || versionId == null) return null;
    const version = renderData.wall.versions?.find((candidate) => candidate.number === versionNumber);
    if (!version || version.id !== versionId || version.status !== 'DRAFT') return null;
    if (draftRemovalGenerations.get(renderData) !== sprayWallRemovalGeneration(layoutId)) return null;
    if (draftViewerGenerations.get(renderData) !== sprayWallViewerGeneration()) return null;
    return mapSprayWallRenderData(layoutId, renderData, Number(versionId), query.dataUpdatedAt);
  }, [layoutId, renderData, versionNumber, versionId, query.dataUpdatedAt, accessGeneration]);

  useEffect(() => {
    // No published generation exists to protect during initial setup. The look
    // carousel still uses the ordinary renderer, so it can register this draft.
    if (!wall || !renderData || renderData.wall.currentVersion != null) return;
    if (draftRemovalGenerations.get(renderData) !== sprayWallRemovalGeneration(layoutId)) return;
    if (draftViewerGenerations.get(renderData) !== sprayWallViewerGeneration()) return;
    registerSprayWall(layoutId, {
      ...wall,
      viewerAccess: {
        canEdit: wall.viewerCanEdit,
        generation: draftViewerGenerations.get(renderData) ?? -1,
      },
    });
  }, [layoutId, renderData, wall]);

  // Captured in a ref so the teardown does not re-run — and therefore does not
  // yank the published wall back mid-session — when the uuid prop settles.
  const queryClient = useQueryClient();
  const teardownRef = useRef({ queryClient, wallUuid, published: renderData?.wall.currentVersion != null });
  teardownRef.current = { queryClient, wallUuid, published: renderData?.wall.currentVersion != null };

  useEffect(
    () => () => {
      // Put the published generation back for whatever outlives this screen, and
      // drop the cached payload with it: this device has been writing to the
      // wall, so a payload from before the session is not to be trusted.
      const { queryClient: client, wallUuid: uuid, published } = teardownRef.current;
      if (!uuid || !published) return;
      void invalidateSprayWallRenderData(client, uuid, layoutId);
    },
    [layoutId],
  );

  const asked = wallUuid != null && versionNumber != null && versionId != null;
  // True from the retry tap until its read has started, so the tap is answered
  // with the loading line while the connectivity probe is still out. It counts
  // as loading and never as unavailable: a read that gave up is no longer
  // pending, and without this the tap would flash "no photo to edit yet".
  const [retrying, setRetrying] = useState(false);
  const isLoading = asked && (retrying || query.isPending);
  // An account/removal transition withdraws private draft geometry immediately.
  // The caller must retry under the current account; delaying that verdict by
  // an effect would expose a stale account's editor for another frame.
  const isUnavailable = asked && !retrying && !query.isPending && wall == null;
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
      .then(() => queryClient.cancelQueries({ queryKey: sprayWallDraftQueryKey(wallUuid, versionNumber, versionId) }))
      // A cancel that fails still ends the "retrying" state and still reads:
      // left set, it would hide the stalled screen behind a spinner for good.
      .catch(() => undefined)
      .then(() => {
        setRetrying(false);
        return refetch();
      });
  }, [queryClient, wallUuid, versionNumber, versionId, refetch]);

  return useMemo(
    () => ({ isLoading, isUnavailable, isStalled, retry, homography, wall }),
    [isLoading, isUnavailable, isStalled, retry, homography, wall],
  );
}

/** Keep an initial unpublished wall available to its look carousel. */
export function useKeepSprayDraftRegistered(
  layoutId: number,
  wallUuid: string | null,
  versionNumber: number | null,
  versionId: string | null,
): void {
  const queryClient = useQueryClient();
  const registeredVersionId = useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(() => getSprayWall(layoutId)?.versionId ?? null, [layoutId]),
  );

  useEffect(() => {
    if (wallUuid == null || versionNumber == null) return;
    if (registeredVersionId === Number(versionId)) return;
    const cached = queryClient.getQueryData<SprayWallRenderDataResponse>(
      sprayWallDraftQueryKey(wallUuid, versionNumber, versionId),
    );
    const payload = cached?.sprayWallRenderData;
    if (!payload) return;
    if (payload.wall.currentVersion != null || versionId == null) return;
    const version = payload.wall.versions?.find((candidate) => candidate.number === versionNumber);
    if (!version || version.id !== versionId || version.status !== 'DRAFT') return;
    if (draftRemovalGenerations.get(payload) !== sprayWallRemovalGeneration(layoutId)) return;
    if (draftViewerGenerations.get(payload) !== sprayWallViewerGeneration()) return;
    const wall = mapSprayWallRenderData(layoutId, payload, Number(versionId), Date.now());
    if (!wall) return;
    registerSprayWall(layoutId, {
      ...wall,
      viewerAccess: {
        canEdit: wall.viewerCanEdit,
        generation: draftViewerGenerations.get(payload) ?? -1,
      },
    });
  }, [layoutId, wallUuid, versionNumber, versionId, registeredVersionId, queryClient]);
}
