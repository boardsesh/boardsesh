import { invert, mapPoint, type ReferenceSize } from '@boardsesh/spray-wall-geometry';
import type { SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';

function withinImage(x: number, y: number, size: ReferenceSize) {
  return x >= 0 && x <= size.width && y >= 0 && y <= size.height;
}

/** Checks canonical coordinates against both the calibrated crop and the original photo pixels. */
export function sprayPhotoCoverage({
  frame,
  photo,
  homography,
}: Pick<SprayLookPreviewSource, 'frame' | 'photo' | 'homography'>): (x: number, y: number) => boolean {
  let frameToPhoto;
  try {
    frameToPhoto = invert(homography);
  } catch {
    return () => false;
  }
  return (x, y) => {
    if (!withinImage(x, y, frame)) return false;
    const [photoX, photoY] = mapPoint(frameToPhoto, x, y);
    return withinImage(photoX, photoY, photo);
  };
}
