import type { SprayLookPreviewSource } from './spray-look-preview';

export function sprayLedPhotoKey(source: Pick<SprayLookPreviewSource, 'versionId' | 'frame' | 'homography'>): string {
  return JSON.stringify([source.versionId, source.frame.width, source.frame.height, source.homography]);
}
