import type { QueryClient } from '@tanstack/react-query';
import type { SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';
import { isNetworkError } from '@boardsesh/offline-sync/error-classification';
import type { CanonicalSprayHold } from '@boardsesh/spray-wall-geometry';
import { getConnectivitySnapshot } from '../connectivity/connectivity-store';
import { lookPreviewSourceFromRenderData, type SprayLookPreviewSource } from './spray-look-preview';
import { sprayPrivacyGeneration } from './spray-privacy-generation';
import { fetchSprayWallRenderData, sprayWallPublishedRenderDataQueryKey } from './spray-wall-loader';
import { getSprayWall, sprayWallRemovalGeneration, sprayWallViewerGeneration } from './spray-wall-registry';

export type SprayLedRouteGeometry = Pick<SprayLookPreviewSource, 'frame' | 'homography'> & {
  holds: readonly CanonicalSprayHold[];
};

function payloadGeometry(
  payload: SprayWallRenderData | null,
  wallUuid: string,
  layoutId: number,
  minimumVersion: number,
): SprayLedRouteGeometry | null {
  if (!payload || payload.wall.uuid !== wallUuid || payload.wall.layoutId !== layoutId) return null;
  const publishedVersion = payload.wall.currentVersion?.number;
  if (
    publishedVersion === undefined ||
    !Number.isSafeInteger(publishedVersion) ||
    publishedVersion < 1 ||
    publishedVersion < minimumVersion ||
    publishedVersion !== payload.versionNumber
  )
    return null;
  const source = lookPreviewSourceFromRenderData(payload, {
    layoutId,
    versionId: payload.wall.currentVersion?.id,
  });
  return source
    ? {
        frame: source.frame,
        homography: source.homography,
        holds: payload.holds.map(({ id, cx, cy, r, outline }) => ({ id, cx, cy, r, outline })),
      }
    : null;
}

const positiveSize = (size: number | null): size is number => size !== null && Number.isFinite(size) && size > 0;

/** Canonical geometry for LAN lighting. A transport failure may use this viewer's published copy. */
export async function loadSprayLedRouteGeometry(
  queryClient: QueryClient,
  wallUuid: string,
  layoutId: number,
): Promise<SprayLedRouteGeometry | null> {
  const viewerGeneration = sprayWallViewerGeneration();
  const removalGeneration = sprayWallRemovalGeneration(layoutId);
  const privacyGeneration = sprayPrivacyGeneration(layoutId);
  const registered = getSprayWall(layoutId);
  if (registered && registered.wallUuid !== wallUuid) return null;
  const isCurrent = () =>
    sprayWallViewerGeneration() === viewerGeneration &&
    sprayWallRemovalGeneration(layoutId) === removalGeneration &&
    sprayPrivacyGeneration(layoutId) === privacyGeneration &&
    getSprayWall(layoutId)?.versionId === registered?.versionId;

  if (!getConnectivitySnapshot().effectiveOffline) {
    try {
      const payload = await fetchSprayWallRenderData(queryClient, wallUuid, viewerGeneration);
      // A server denial or malformed response is authoritative, even if an older copy exists.
      return isCurrent() ? payloadGeometry(payload, wallUuid, layoutId, registered?.version ?? 0) : null;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
    }
  }
  if (!isCurrent()) return null;
  const cached = queryClient.getQueryData<{ sprayWallRenderData: SprayWallRenderData | null }>(
    sprayWallPublishedRenderDataQueryKey(wallUuid, viewerGeneration),
  );
  if (cached?.sprayWallRenderData === null) return null;
  const cachedPayload = cached?.sprayWallRenderData;
  if (cachedPayload) {
    const geometry = payloadGeometry(cachedPayload, wallUuid, layoutId, registered?.version ?? 0);
    if (geometry) return geometry;
  }

  // The registry holds photo pixels; the owner-gated mirror retains the original canonical holds.
  const [{ getDatabaseHandle }, { getSprayWallLocal }, { readLocalUserId }] = await Promise.all([
    import('../../db'),
    import('../../db/queries/get-spray-wall-local'),
    import('../local-user-id'),
  ]);
  const db = getDatabaseHandle();
  if (!db || !isCurrent()) return null;
  const userId = await readLocalUserId();
  if (!userId || !isCurrent()) return null;
  const wall = await getSprayWallLocal(db, layoutId, userId);
  if (
    !wall ||
    !isCurrent() ||
    wall.boardUuid !== wallUuid ||
    wall.layoutId !== layoutId ||
    wall.version === null ||
    !Number.isSafeInteger(wall.version) ||
    wall.version < 1 ||
    wall.version < (registered?.version ?? 0) ||
    !positiveSize(wall.referenceWidth) ||
    !positiveSize(wall.referenceHeight) ||
    !wall.homography ||
    wall.homography.length !== 9 ||
    !wall.homography.every(Number.isFinite)
  )
    return null;
  const photoMatch =
    /^spray-walls\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jpg$/i.exec(
      wall.photoKey ?? '',
    );
  if (!photoMatch || photoMatch[1] !== wallUuid) return null;
  if ((await readLocalUserId()) !== userId || !isCurrent()) return null;
  const verified = await getSprayWallLocal(db, layoutId, userId);
  if (!verified || verified.photoKey !== wall.photoKey || verified.version !== wall.version || !isCurrent())
    return null;
  return {
    frame: { width: wall.referenceWidth, height: wall.referenceHeight },
    homography: [...wall.homography],
    holds: wall.holds,
  };
}
