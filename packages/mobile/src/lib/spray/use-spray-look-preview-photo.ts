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
  // for the same version is the same file, so on its own it is not a reason to
  // re-run; after a miss it is (below).
  const signature = useRef<{ url: string; expiresAt: string } | null>(null);
  signature.current = source ? { url: source.photoUrl, expiresAt: source.photoExpiresAt } : null;
  const [resolved, setResolved] = useState<{ key: string; uri: string | null; expiresAt: string } | null>(null);
  // Read by the effect to skip work it has already done: a file it found, or a
  // link it already failed with.
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;
  const key = layoutId != null && versionId != null ? `${layoutId}:${versionId}` : null;
  // A miss is retried once the payload brings a DIFFERENT signature: the
  // likeliest miss is a link that lapsed (15 min) before the file was fetched,
  // and the refetched payload for the same version is the way out.
  const failedWith = resolved && resolved.key === key && resolved.uri === null ? resolved.expiresAt : null;
  const retryWith =
    failedWith !== null && source?.photoExpiresAt != null && source.photoExpiresAt !== failedWith
      ? source.photoExpiresAt
      : null;

  useEffect(() => {
    const current = signature.current;
    if (layoutId == null || versionId == null || !current?.url) return;
    const ownKey = `${layoutId}:${versionId}`;
    const last = resolvedRef.current;
    if (last && last.key === ownKey && (last.uri !== null || last.expiresAt === current.expiresAt)) return;
    let live = true;
    void ensureSprayPhotoCached({ layoutId, versionId }, current)
      .catch(() => null)
      .then((path) => {
        if (live) setResolved({ key: ownKey, uri: cachedPhotoUri(path), expiresAt: current.expiresAt });
      });
    return () => {
      live = false;
    };
  }, [layoutId, versionId, retryWith]);

  return resolved && resolved.key === key ? resolved.uri : null;
}
