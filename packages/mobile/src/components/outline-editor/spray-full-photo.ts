// The hold editor's sharper photo (#5911): when to fetch it, and what to call it.
//
// The server keeps a 2048 px base for every wall and, for a photo uploaded
// larger, a copy at up to 4096 px beside it. The base is what the canonical
// frame, the detector, the climb view and search all read. Only the hold editor
// zooms deep enough to run out of its pixels, so only the editor asks for the
// copy, and only once the climber zooms in.

import type { FullResolutionPhoto } from '../search/FullResolutionPhotoLayer';
import type { SprayFullPhotoRequest } from '../../lib/spray/spray-photo-cache';

/**
 * The zoom past which the editor fetches the full-resolution photo.
 *
 * On a phone the base's 2048 px already fill the screen's own pixels at 1x and
 * are visibly soft by 3x. Fetching any earlier would cost a 48 MB decode
 * (4096x3072 RGBA) on every visit that only glances at the wall.
 */
export const SPRAY_FULL_PHOTO_MIN_SCALE = 3;

/**
 * A load that fails this close to the signature's expiry is treated as an
 * expired signature: the phone's clock and the server's need not agree.
 */
const SIGNATURE_EXPIRY_MARGIN_MS = 60 * 1000;

/**
 * The full-resolution photo for one draft, or null when there is none.
 *
 * Null for every wall uploaded before #5911 and for any photo that was already
 * 2048 px or smaller. The editor then shows the base alone, exactly as before.
 *
 * The cache key names the version, not the signature. A version's photo never
 * changes, and the draft is refetched during a long sitting, so the decoded
 * image survives the new URL.
 *
 * `keepOnDisk` (`ensureSprayFullPhotoCached`) keeps the downloaded file, so the
 * next visit, and the next draft on the same photo, decodes it instead of
 * downloading several megabytes again. Left out, the layer loads the URL.
 */
export function sprayFullResolutionPhoto(
  wall: { layoutId: number; wallUuid: string; versionId: number | string; photoExpiresAt: string } | null,
  photoFullUrl: string | null,
  keepOnDisk?: (request: SprayFullPhotoRequest) => Promise<string | null>,
): FullResolutionPhoto | null {
  if (!wall || !photoFullUrl) return null;
  const photo: FullResolutionPhoto = {
    uri: photoFullUrl,
    cacheKey: `spray-full/${wall.wallUuid}/v${wall.versionId}`,
    minScale: SPRAY_FULL_PHOTO_MIN_SCALE,
  };
  if (!keepOnDisk) return photo;
  const request: SprayFullPhotoRequest = {
    layoutId: wall.layoutId,
    wallUuid: wall.wallUuid,
    url: photoFullUrl,
    expiresAt: wall.photoExpiresAt,
  };
  return { ...photo, loadFromDisk: () => keepOnDisk(request) };
}

/**
 * Whether a photo signature has lapsed (or is about to), so reading the draft
 * again would hand back a URL that loads.
 *
 * The full photo is first fetched when the climber zooms past 3x, which in a
 * long sitting can be well after the 15-minute signature the draft was read
 * with. An unreadable expiry answers false: refetching on a guess could loop on a
 * photo that fails for some other reason.
 */
export function photoSignatureLapsed(expiresAt: string, nowMs: number): boolean {
  const expiryMs = Date.parse(expiresAt);
  return Number.isFinite(expiryMs) && expiryMs - SIGNATURE_EXPIRY_MARGIN_MS <= nowMs;
}
