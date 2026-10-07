// The look picker's photo, from the same on-disk copy the board draws.
//
// The tiles never draw the presigned URL on native. react-native-svg's image
// loader (the Android mesh) keeps a disk cache for network images, and a
// private wall's photo must not land in a cache nothing clears on sign-out.
// The spray photo cache (`spray-photo-cache.ts`) is the one copy we own: the
// sweeper, the retention purge and a withdrawal all delete it. A draft or a
// wall on the board usually has its file there already; otherwise this
// downloads it there, once, with the payload's own signature.
//
// In a browser the cache's twin hands back the presigned URL itself, and the
// HTTP cache is the cache (`spray-photo-cache.web.ts`).

import { useEffect, useRef, useState } from 'react';
import { ensureSprayPhotoCached } from './spray-photo-cache';
import { cachedPhotoUri, type SprayLookPreviewSource } from './spray-look-preview';

/** The photo's URI to draw from, or null until it is on disk (or for good, when it cannot be). */
export function useSprayLookPreviewPhoto(source: SprayLookPreviewSource | null): string | null {
  const layoutId = source?.layoutId ?? null;
  const versionId = source?.versionId ?? null;
  // The newest signature, read when a download starts. A refreshed signature
  // for the same version is the same file, so it is not a reason to re-run.
  const signature = useRef<{ url: string; expiresAt: string } | null>(null);
  signature.current = source ? { url: source.photoUrl, expiresAt: source.photoExpiresAt } : null;
  const [resolved, setResolved] = useState<{ key: string; uri: string | null } | null>(null);
  const key = layoutId != null && versionId != null ? `${layoutId}:${versionId}` : null;

  useEffect(() => {
    const current = signature.current;
    if (layoutId == null || versionId == null || !current?.url) return;
    let live = true;
    const ownKey = `${layoutId}:${versionId}`;
    void ensureSprayPhotoCached({ layoutId, versionId }, current)
      .catch(() => null)
      .then((path) => {
        if (live) setResolved({ key: ownKey, uri: cachedPhotoUri(path) });
      });
    return () => {
      live = false;
    };
  }, [layoutId, versionId]);

  return resolved && resolved.key === key ? resolved.uri : null;
}
