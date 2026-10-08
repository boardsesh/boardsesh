/**
 * How big a spray wall photo may be, for the app's upload and the server's
 * full-resolution copy (#5911). One rule in one place, so the phone never
 * uploads pixels the server would throw away, and the server never stores a
 * copy the phone cannot draw.
 *
 * Two limits, and a photo has to fit both:
 *
 *  - **The long side, 5712 px.** That is a 24 MP phone photo (5712 x 4284), the
 *    default capture on recent flagships, so it goes up unscaled. The hold
 *    editor zooms to 8x, and every extra pixel there is a sharper hold edge.
 *  - **The pixel count, 5712 x 4284.** A decoded photo costs 4 bytes a pixel, so
 *    this is 97.9 MB. Android refuses to draw any bitmap over 100 MiB
 *    (104.9 MB): `RecordingCanvas` throws "Canvas: trying to draw too large
 *    bitmap", and on Android 9 and older nothing in expo-image scales it down
 *    first. A long-side cap alone would let a square photo through at
 *    5712 x 5712, which is 130 MB and a crash. With the pixel cap a square photo
 *    tops out at 4946 x 4946.
 *
 * The 2048 px base the frame, the detector and the climb view read is a
 * separate, smaller limit and stays on the server.
 */

/** Longest side, in pixels, of an uploaded wall photo and of the server's full copy. */
export const SPRAY_WALL_PHOTO_MAX_LONG_SIDE = 5712;

/** Most pixels a wall photo may have: a 24 MP 4:3 photo, 97.9 MB decoded. */
export const SPRAY_WALL_PHOTO_MAX_PIXELS = 5712 * 4284;

/**
 * The longest side a photo of this shape may keep under both limits.
 *
 * Only the aspect ratio matters, so it does not care which way round width and
 * height are. That matters on Android, where the picker can report the sensor's
 * landscape numbers for a portrait photo.
 *
 * A size that is not two real, positive numbers answers the plain long-side
 * cap: there is no shape to work from, and the caller's resize is skipped for
 * an unknown size anyway.
 *
 * The resize that follows rounds the short side, which can add up to half a
 * row of pixels over the cap: at most 2856 pixels, 11 KB decoded, far inside
 * the 7 MB between the cap and Android's limit.
 */
export function sprayWallPhotoMaxLongSide(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return SPRAY_WALL_PHOTO_MAX_LONG_SIDE;
  }
  const aspect = Math.max(width, height) / Math.min(width, height);
  // long x (long / aspect) <= MAX_PIXELS  =>  long <= sqrt(MAX_PIXELS x aspect).
  // The small epsilon keeps a 4:3 photo at exactly 5712: the square root of
  // 5712² can come out a hair under it in floating point.
  const longSideForPixels = Math.floor(Math.sqrt(SPRAY_WALL_PHOTO_MAX_PIXELS * aspect) + 1e-6);
  return Math.min(SPRAY_WALL_PHOTO_MAX_LONG_SIDE, longSideForPixels);
}
