// Getting a usable photograph of a wall out of the phone (epic #5346, SW-09).
//
// Between the picker and the upload there is one compression step, and it earns
// its place three times over: it caps the upload at something a gym's wifi can
// carry, it converts HEIC (which the backend does not accept) to JPEG, and it
// BAKES THE EXIF ORIENTATION into the pixels. That last one is the important
// one. Anchors are four points in the photo's pixel space and holds are stored
// through a homography solved in it, so a photo whose orientation still lives in
// a metadata tag is a photo where "the top-left corner" means two different
// things depending on who is reading it.

import * as ImagePicker from 'expo-image-picker';
import { compressPickedImage } from '../image-compression';

/** Longest edge of an uploaded wall photo. */
export const WALL_PHOTO_MAX_DIMENSION = 2048;
/** JPEG quality. The hold editor traces silhouettes on these pixels. */
export const WALL_PHOTO_QUALITY = 0.85;

export type PickedWallPhotoFile = {
  uri: string;
  width: number;
  height: number;
};

/**
 * The size `compressPickedImage` will leave a photo at.
 *
 * Mirrors its rule — constrain whichever side is longer, preserve the aspect
 * ratio, leave an already-small photo alone — because the compressor answers
 * with a URI and nothing else, and the anchors step needs a pixel space to draw
 * in before anything has been uploaded.
 *
 * It is a PREDICTION, and it does not have to be exact: every coordinate that
 * leaves this flow is rescaled by the STORED photo's real dimensions, which the
 * upload handler reports. A pixel of rounding drift here costs nothing.
 */
export function predictCompressedSize(
  width: number,
  height: number,
  maxDimension = WALL_PHOTO_MAX_DIMENSION,
): { width: number; height: number } {
  // Anything that is not a real, positive pixel count answers zero rather than
  // being passed through. A picker that could not report a size hands back 0 —
  // and on some providers NaN — and `NaN` flowing on would make every anchor and
  // every rescaled candidate NaN too, which draws nothing and says nothing.
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { width, height };
  const scale = maxDimension / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * Rescale a point measured on one version of a photo onto another.
 *
 * Used for the anchor quad: it is tapped on the LOCAL compressed file and stored
 * against the photo the server re-encoded, and while those are almost always the
 * same size, "almost always" is not a coordinate system.
 */
export function rescalePoint(
  point: readonly [number, number],
  from: { width: number; height: number },
  to: { width: number; height: number },
): [number, number] {
  if (!(from.width > 0) || !(from.height > 0)) return [point[0], point[1]];
  return [(point[0] * to.width) / from.width, (point[1] * to.height) / from.height];
}

export type WallPhotoPickResult =
  | { outcome: 'picked'; photo: PickedWallPhotoFile }
  | { outcome: 'cancelled' }
  | { outcome: 'denied' };

async function compressAsset(asset: ImagePicker.ImagePickerAsset): Promise<PickedWallPhotoFile> {
  const uri = await compressPickedImage(asset.uri, asset.width, asset.height, {
    maxDimension: WALL_PHOTO_MAX_DIMENSION,
    quality: WALL_PHOTO_QUALITY,
  });
  const size = predictCompressedSize(asset.width, asset.height);
  return { uri, width: size.width, height: size.height };
}

/** Pick a wall photo from the library and compress it. Throws only on a real failure. */
export async function pickWallPhotoFromLibrary(): Promise<WallPhotoPickResult> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return { outcome: 'denied' };
  // `quality: 1` — we do our own compression below and want the full-quality
  // file to do it from, exactly as the screenshot picker does.
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return { outcome: 'cancelled' };
  return { outcome: 'picked', photo: await compressAsset(asset) };
}

/**
 * Photograph the wall and compress the result.
 *
 * ONLY call this on a binary that `canPhotographWall()` vouches for. Without
 * `NSCameraUsageDescription` iOS does not deny the request, it terminates the
 * process, so the gate belongs before the call and not inside it.
 */
export async function pickWallPhotoFromCamera(): Promise<WallPhotoPickResult> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return { outcome: 'denied' };
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return { outcome: 'cancelled' };
  return { outcome: 'picked', photo: await compressAsset(asset) };
}
