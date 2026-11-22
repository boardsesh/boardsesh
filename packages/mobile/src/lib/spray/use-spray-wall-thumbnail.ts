import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  GET_SPRAY_WALL_THUMBNAIL,
  type GetSprayWallThumbnailQueryResponse,
} from '@boardsesh/graphql/operations/spray-walls';
import { useIsOffline } from '../../hooks/use-is-offline';
import { getHttpClient } from '../graphql/client';
import { ensureSprayPhotoCached, tryGetSprayPhotoPathSync } from './spray-photo-cache';
import { cachedPhotoUri } from './spray-look-preview';
import { sprayPrivacyGeneration } from './spray-privacy-generation';
import {
  getSprayWall,
  ensureSprayWallLoaded,
  sprayCacheToken,
  sprayWallViewerGeneration,
  subscribeToSprayWalls,
} from './spray-wall-registry';

type ThumbnailIdentity = { wallUuid: string; layoutId: number; draftVersionId?: string | null };
type ThumbnailPhoto = { uri: string; aspectRatio: number };
const SIGNATURE_REFRESH_MS = 10 * 60 * 1000;

/**
 * Read a known wall by its UUID, including an owner's exact unfinished version.
 * Photos stay in the owned native cache; unpublished holds never enter the
 * published render registry. The browser cache twin returns the signed URL.
 */
export function useSprayWallThumbnail({
  wallUuid,
  layoutId,
  draftVersionId = null,
}: ThumbnailIdentity): ThumbnailPhoto | null {
  const offline = useIsOffline();
  // Also observe registration, so an offline photo already loaded by another
  // surface can fill this slot without asking the published loader to run.
  const registryToken = useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(
      () => `${sprayPrivacyGeneration(layoutId)}:${sprayWallViewerGeneration()}:${sprayCacheToken('spray', layoutId)}`,
      [layoutId],
    ),
  );
  const privacyGeneration = sprayPrivacyGeneration(layoutId);
  const viewerGeneration = sprayWallViewerGeneration();
  // Offline only: the installed loader hydrates an account-owned downloaded
  // wall from SQLite. Online reads keep the known UUID capability instead of
  // going through the enumerable layout lookup.
  useEffect(() => {
    if (offline && draftVersionId === null) ensureSprayWallLoaded(layoutId);
  }, [offline, draftVersionId, layoutId, registryToken]);
  const query = useQuery({
    queryKey: ['sprayWallThumbnail', wallUuid, layoutId, privacyGeneration, viewerGeneration, draftVersionId],
    enabled: !offline && wallUuid.length > 0 && Number.isSafeInteger(layoutId) && layoutId > 0,
    queryFn: async (): Promise<GetSprayWallThumbnailQueryResponse> => {
      const response = await getHttpClient().request<GetSprayWallThumbnailQueryResponse>(GET_SPRAY_WALL_THUMBNAIL, {
        uuid: wallUuid,
        includeDrafts: draftVersionId !== null,
      });
      // An old request must not retain private signatures after withdrawal or
      // an account change, even in its now-unused React Query cache entry.
      if (privacyGeneration !== sprayPrivacyGeneration(layoutId) || viewerGeneration !== sprayWallViewerGeneration())
        return { sprayWall: null };
      return response;
    },
    staleTime: SIGNATURE_REFRESH_MS,
    gcTime: SIGNATURE_REFRESH_MS,
    refetchInterval: offline ? false : SIGNATURE_REFRESH_MS,
    refetchOnWindowFocus: true,
  });

  const wall = query.data?.sprayWall;
  const matchingWall = wall?.uuid === wallUuid && wall.layoutId === layoutId ? wall : null;
  const version = draftVersionId
    ? matchingWall?.versions?.find((candidate) => candidate.id === draftVersionId)
    : matchingWall?.currentVersion;
  const versionId = Number(version?.id);
  const photo = version?.photo;
  const validPhoto =
    Number.isSafeInteger(versionId) &&
    versionId > 0 &&
    photo?.url &&
    typeof photo.width === 'number' &&
    typeof photo.height === 'number' &&
    photo.width > 0 &&
    photo.height > 0;
  const sourceKey = validPhoto
    ? JSON.stringify([wallUuid, layoutId, privacyGeneration, viewerGeneration, versionId, photo.url, photo.expiresAt])
    : null;
  const [resolved, setResolved] = useState<{ key: string; photo: ThumbnailPhoto } | null>(null);
  const photoUrl = validPhoto ? photo.url : null;
  const expiresAt = validPhoto ? photo.expiresAt : null;
  const aspectRatio = validPhoto ? photo.width! / photo.height! : null;

  useEffect(() => {
    if (!sourceKey || !photoUrl || !expiresAt || aspectRatio === null) return;
    let live = true;
    void ensureSprayPhotoCached({ layoutId, versionId }, { url: photoUrl, expiresAt })
      .catch(() => null)
      .then((path) => {
        const uri = cachedPhotoUri(path);
        if (
          live &&
          uri &&
          privacyGeneration === sprayPrivacyGeneration(layoutId) &&
          viewerGeneration === sprayWallViewerGeneration()
        )
          setResolved({ key: sourceKey, photo: { uri, aspectRatio } });
      });
    return () => {
      live = false;
    };
  }, [sourceKey, layoutId, versionId, photoUrl, expiresAt, aspectRatio, privacyGeneration, viewerGeneration]);

  if (sourceKey && resolved?.key === sourceKey) return resolved.photo;
  // Only an offline, UUID-matched registration can substitute for a missing
  // query answer. A live authority answer of null must never show cached art.
  if (offline && query.data === undefined) {
    const registered = getSprayWall(layoutId);
    if (
      registered?.wallUuid === wallUuid &&
      registered.registeredAtMs > 0 &&
      (draftVersionId !== null || !registered.draft) &&
      (!draftVersionId || String(registered.versionId) === draftVersionId) &&
      registered.photoWidth > 0 &&
      registered.photoHeight > 0
    ) {
      const uri = cachedPhotoUri(tryGetSprayPhotoPathSync({ layoutId, versionId: registered.versionId }));
      if (uri?.startsWith('file://')) return { uri, aspectRatio: registered.photoWidth / registered.photoHeight };
    }
  }
  return null;
}
