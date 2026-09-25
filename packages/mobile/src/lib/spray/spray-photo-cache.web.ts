// Browser twin of `spray-photo-cache.ts`.
//
// `expo-file-system` has no browser build (same reason `cache-dir-io.web.ts`
// exists), and a browser needs no local copy anyway: an `<img>` loads the
// presigned URL directly and the HTTP cache is the disk cache. So the "path" a
// web caller gets back IS the URL, which is exactly what the view layer feeds
// `<Image source>` on this platform.
//
// The signature expires after fifteen minutes. That is the same contract as on
// native — re-run the query, do not persist the URL — and here it is the browser,
// not us, that re-requests it.

import { getSprayWall } from './spray-wall-registry';
import type { SprayPhotoIdentity } from './spray-photo-keys';

// Names live in a leaf module so the render path and the sweeper can use them
// without importing `expo-file-system`; re-exported here because this is where
// callers expect to find them.
export {
  SPRAY_BACKGROUND_KEY_PREFIX,
  SPRAY_PHOTO_CACHE_DIR_NAME,
  parseSprayBackgroundKey,
  sprayBackgroundKey,
  sprayPhotoFileName,
  type SprayPhotoIdentity,
} from './spray-photo-keys';

/** Nothing is on disk in a browser, so nothing is ever protected from a sweep either. */
export function liveSprayPhotoFileNames(): Set<string> {
  return new Set<string>();
}

function presignedUrl(identity: SprayPhotoIdentity): string | null {
  const wall = getSprayWall(identity.layoutId);
  if (!wall || wall.version !== identity.version) return null;
  return wall.photoUrl;
}

export function tryGetSprayPhotoPathSync(identity: SprayPhotoIdentity): string | null {
  return presignedUrl(identity);
}

export function ensureSprayPhotoCached(identity: SprayPhotoIdentity): Promise<string | null> {
  return Promise.resolve(presignedUrl(identity));
}

export function clearSprayPhotoPathCache(): void {
  // No memo to clear: the URL comes straight off the registry on every read.
}

export function resetSprayPhotoCacheForTests(): void {
  // Same: nothing is memoised in a browser.
}
