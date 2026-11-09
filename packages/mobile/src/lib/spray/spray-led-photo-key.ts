import type { SprayLookPreviewSource } from './spray-look-preview';

/** A hold edit publishes a new version on the same photo and mapping, so the version is not part of this identity. */
export function sprayLedPhotoKey(source: Pick<SprayLookPreviewSource, 'frame' | 'homography'>): string {
  return JSON.stringify([source.frame.width, source.frame.height, source.homography]);
}
