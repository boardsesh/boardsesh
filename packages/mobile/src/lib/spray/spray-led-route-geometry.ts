import type { QueryClient } from '@tanstack/react-query';
import type { SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';
import { isNetworkError } from '@boardsesh/offline-sync/error-classification';
import type { CanonicalSprayHold } from '@boardsesh/spray-wall-geometry';
import { getConnectivitySnapshot } from '../connectivity/connectivity-store';
import { readLocalUserId } from '../local-user-id';
import { getPreference, removePreference, setPreference } from '../preference-store';
import { lookPreviewSourceFromRenderData, type SprayLookPreviewSource } from './spray-look-preview';
import { sprayPrivacyGeneration } from './spray-privacy-generation';
import {
  fetchSprayWallRenderData,
  requestSprayWallRenderData,
  sprayWallPublishedRenderDataQueryKey,
} from './spray-wall-loader';
import {
  getSprayWall,
  settleSprayWallRenderMiss,
  sprayWallRemovalGeneration,
  sprayWallViewerGeneration,
} from './spray-wall-registry';
import { serializeSprayWallLedCacheWrite } from './spray-wall-led-cache';
import { recheckSprayWallLedAccess } from './spray-wall-led-sync';

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

// A published miss is authority, even after QueryClient/registry state is lost.
// Keep only the denial here, scoped to its account; SQLite still owns geometry.
const denialGenerations = new Map<string, number>();
const knownDenials = new Set<string>();
const denialKey = (userId: string, wallUuid: string) =>
  `sprayWallLedRouteDenied:${encodeURIComponent(userId)}:${encodeURIComponent(wallUuid)}`;

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
  const baseIsCurrent = () =>
    sprayWallViewerGeneration() === viewerGeneration &&
    sprayWallRemovalGeneration(layoutId) === removalGeneration &&
    sprayPrivacyGeneration(layoutId) === privacyGeneration &&
    getSprayWall(layoutId)?.versionId === registered?.versionId;
  const userId = await readLocalUserId();
  if (!baseIsCurrent()) return null;
  const accessKey = userId ? denialKey(userId, wallUuid) : null;
  const denialGeneration = accessKey ? (denialGenerations.get(accessKey) ?? 0) : 0;
  const isCurrent = () =>
    baseIsCurrent() && (!accessKey || (denialGenerations.get(accessKey) ?? 0) === denialGeneration);
  let denied = accessKey !== null && knownDenials.has(accessKey);
  if (accessKey) {
    try {
      denied = await serializeSprayWallLedCacheWrite(wallUuid, async () => {
        const stored = await getPreference<unknown>(accessKey, { strictParsing: true });
        if (stored !== null) knownDenials.add(accessKey);
        // A previous disk failure must not restore eligibility in this process.
        // Retry the denial write before a future restart can lose that evidence.
        if (stored === null && knownDenials.has(accessKey)) await setPreference(accessKey, true);
        return knownDenials.has(accessKey);
      });
    } catch {
      // An unreadable access record cannot authorize offline fallback.
      denied = true;
    }
  }
  if (!isCurrent()) return null;
  const recordMiss = async () => {
    if ((await readLocalUserId()) !== userId || !isCurrent()) return;
    if (accessKey) {
      denialGenerations.set(accessKey, denialGeneration + 1);
      knownDenials.add(accessKey);
    }
    try {
      if (accessKey) await serializeSprayWallLedCacheWrite(wallUuid, () => setPreference(accessKey, true));
    } finally {
      if (baseIsCurrent()) {
        // Preserve the loader's draft exception and withdraw published geometry.
        settleSprayWallRenderMiss(layoutId, wallUuid);
        // A cold miss has no registered wall to notify; recheck its LED copy too.
        recheckSprayWallLedAccess(wallUuid);
      }
    }
  };

  if (!getConnectivitySnapshot().effectiveOffline) {
    try {
      // Recovery must neither reuse a pre-denial request nor cancel the wall
      // loader's shared read (its cancellation could withdraw a hydrated wall).
      const payload = denied
        ? await requestSprayWallRenderData(wallUuid)
        : await fetchSprayWallRenderData(queryClient, wallUuid, viewerGeneration);
      if ((await readLocalUserId()) !== userId || !isCurrent()) return null;
      if (!payload) {
        await recordMiss();
        return null;
      }
      const geometry = payloadGeometry(payload, wallUuid, layoutId, registered?.version ?? 0);
      if (!geometry) return null;
      if (denied && accessKey) {
        await serializeSprayWallLedCacheWrite(wallUuid, async () => {
          if (!isCurrent()) return;
          const queryKey = sprayWallPublishedRenderDataQueryKey(wallUuid, viewerGeneration);
          // Online lighting may use this verified read, but an older shared
          // fetch must not later replace it and reauthorize offline fallback.
          // Retain the fence until a fresh recovery can safely resume caching.
          const hasPendingRead = () => {
            const state = queryClient.getQueryState(queryKey);
            return state !== undefined && state.fetchStatus !== 'idle';
          };
          if (hasPendingRead()) return;
          queryClient.setQueryData(queryKey, { sprayWallRenderData: payload });
          const verifiedCache = queryClient.getQueryData(queryKey);
          await removePreference(accessKey);
          if (!isCurrent()) return;
          // Another surface can start or finish a read during native storage I/O.
          if (hasPendingRead() || queryClient.getQueryData(queryKey) !== verifiedCache) {
            await setPreference(accessKey, true);
            return;
          }
          knownDenials.delete(accessKey);
        });
      }
      return isCurrent() ? geometry : null;
    } catch (error) {
      if (!isNetworkError(error)) throw error;
    }
  }
  if (!userId || denied || !isCurrent()) return null;
  const cached = queryClient.getQueryData<{ sprayWallRenderData: SprayWallRenderData | null }>(
    sprayWallPublishedRenderDataQueryKey(wallUuid, viewerGeneration),
  );
  if (cached?.sprayWallRenderData === null) {
    await recordMiss();
    return null;
  }
  const cachedPayload = cached?.sprayWallRenderData;
  if (cachedPayload) {
    const geometry = payloadGeometry(cachedPayload, wallUuid, layoutId, registered?.version ?? 0);
    if (geometry) return geometry;
  }

  // The registry holds photo pixels; the owner-gated mirror retains the original canonical holds.
  const [{ getDatabaseHandle }, { getSprayWallLocal }] = await Promise.all([
    import('../../db'),
    import('../../db/queries/get-spray-wall-local'),
  ]);
  const db = getDatabaseHandle();
  if (!db || !isCurrent()) return null;
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
