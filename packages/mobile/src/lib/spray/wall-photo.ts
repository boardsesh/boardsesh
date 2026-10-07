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
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { compressPickedImageWithSize } from '../image-compression';
import { reportError } from '../error-reporting';
import {
  isIdentityEdit,
  planWallPhotoRender,
  renderableOriginalSize,
  rotatedSize,
  type EditableWallPhoto,
  type PixelSize,
  type QuarterTurns,
  type WallPhotoEdit,
  type WallPhotoFile,
} from './photo-edit';

/**
 * Longest edge of an uploaded wall photo.
 *
 * 4096, not the 2048 the wall is drawn at (#5911). The server keeps a 2048 px
 * base for the canonical frame, the detector and the climb view, and stores this
 * larger copy beside it for the hold editor to swap in once it zooms past 3x.
 * A 12 MP phone photo (4032x3024) goes up unscaled. Eight sample wall photos
 * came to 1.5–2.6 MB at JPEG 0.85 and at most 4.7 MB at 0.95, and even pure
 * noise at 4096x3072 stays under 13 MB, so the handler's 15 MB cap needs no
 * second, lower-quality pass.
 */
export const WALL_PHOTO_MAX_DIMENSION = 4096;
/** JPEG quality. The hold editor traces silhouettes on these pixels. */
export const WALL_PHOTO_QUALITY = 0.85;

/**
 * What the pickers answer: the compressed photo, plus what the crop step needs
 * to re-edit it later (`photo-edit.ts`). `edit` is always null straight out of
 * the picker.
 */
export type PickedWallPhotoFile = EditableWallPhoto;

/**
 * Longest edge of a rotated preview on the crop step. It is only ever drawn a
 * few hundred points wide, so there is no reason to hold a full-size bitmap.
 */
const ROTATED_PREVIEW_MAX_DIMENSION = 1600;

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

/** What the library picker can answer. It asks for no permission, so it cannot be denied. */
export type WallPhotoLibraryResult = { outcome: 'picked'; photo: PickedWallPhotoFile } | { outcome: 'cancelled' };

/** What the camera can answer: the same, plus a climber who refused camera access. */
export type WallPhotoCameraResult = WallPhotoLibraryResult | { outcome: 'denied' };

async function compressAsset(asset: ImagePicker.ImagePickerAsset): Promise<PickedWallPhotoFile> {
  const compressed = await compressPickedImageWithSize(asset.uri, asset.width, asset.height, {
    maxDimension: WALL_PHOTO_MAX_DIMENSION,
    quality: WALL_PHOTO_QUALITY,
  });
  // The rendered size when the platform reports one: it is measured after the
  // orientation was baked in, which the picker's own numbers are not on every
  // Android build. The prediction is the fallback, as it always was.
  const measured = compressed.width > 0 && compressed.height > 0;
  const size = measured
    ? { width: compressed.width, height: compressed.height }
    : predictCompressedSize(asset.width, asset.height);
  const base: WallPhotoFile = { uri: compressed.uri, width: size.width, height: size.height };
  const pickedLongSide = Math.max(asset.width, asset.height);
  return {
    ...base,
    base,
    original: { uri: asset.uri, longSide: Number.isFinite(pickedLongSide) && pickedLongSide > 0 ? pickedLongSide : 0 },
    edit: null,
  };
}

type ManipulatorContext = ReturnType<typeof ImageManipulator.manipulate>;

/** Render a context and save it as a JPEG, answering with the rendered image's real size. */
async function saveRendered(context: ManipulatorContext, quality: number, expected: PixelSize): Promise<WallPhotoFile> {
  const image = await context.renderAsync();
  try {
    const saved = await image.saveAsync({ compress: quality, format: SaveFormat.JPEG });
    // The rendered `ImageRef`'s size, not the plan's: the plan is arithmetic on
    // a size that was itself derived, and the uploaded file's pixels are what
    // the anchors are tapped in.
    const measured = image.width > 0 && image.height > 0;
    return {
      uri: saved.uri,
      width: measured ? image.width : expected.width,
      height: measured ? image.height : expected.height,
    };
  } finally {
    image.release();
  }
}

async function renderEditFrom(uri: string, sourceSize: PixelSize, edit: WallPhotoEdit): Promise<WallPhotoFile> {
  const plan = planWallPhotoRender(edit, sourceSize, WALL_PHOTO_MAX_DIMENSION);
  const context = ImageManipulator.manipulate(uri);
  for (const op of plan.ops) {
    if (op.type === 'rotate') context.rotate(op.degrees);
    else if (op.type === 'crop') context.crop(op.rect);
    else context.resize('width' in op ? { width: op.width } : { height: op.height });
  }
  return saveRendered(context, WALL_PHOTO_QUALITY, plan.output);
}

/**
 * Apply a crop-and-rotate edit, in one pass: rotate, crop, then shrink to
 * `WALL_PHOTO_MAX_DIMENSION` and encode at `WALL_PHOTO_QUALITY`.
 *
 * Reads the picker's ORIGINAL where it can, so a crop keeps the camera's own
 * pixels rather than enlarging a compressed copy. Falls back to the base — the
 * same edit, planned against the base's size — when the original is too big to
 * decode safely (`ORIGINAL_RENDER_MAX_PIXELS`), has gone from the cache, or
 * fails to render for any other reason (an Android crop that reaches past a
 * bitmap whose real size differs from the derived one throws). The identity
 * edit renders nothing: the base IS that photo.
 *
 * The output is bounded like the compressor's: at most 4096 px on the long
 * side, so at most 4096 x 4096 for a square crop of a 24 MP photo. That is a
 * third more pixels than a 4096 x 3072 photo, which puts a real wall photo at
 * about 3.5 MB against the upload's 15 MB cap, the same headroom a square
 * original gets from the compressor.
 *
 * Throws only when the base cannot be rendered either.
 */
export async function renderWallPhotoEdit(photo: EditableWallPhoto, edit: WallPhotoEdit): Promise<WallPhotoFile> {
  if (isIdentityEdit(edit)) return { uri: photo.base.uri, width: photo.base.width, height: photo.base.height };
  const original = renderableOriginalSize(photo.base, photo.original.longSide);
  if (original) {
    try {
      return await renderEditFrom(photo.original.uri, original, edit);
    } catch (error) {
      // Reported so an Android orientation surprise is visible, then absorbed:
      // the base gives the same crop at a little less detail.
      reportError(error);
    }
  }
  return renderEditFrom(photo.base.uri, photo.base, edit);
}

/**
 * The base turned `turns` quarter turns clockwise, for the crop step to draw.
 *
 * A rendered file rather than a view transform, because a rotated view hands
 * gesture translations back in ITS axes: every drag on the crop box would need
 * un-rotating, per frame, on the UI thread. With a real rotated image the crop
 * maths only ever works in the space the climber sees. No turn is the base
 * itself.
 */
export async function renderRotatedPreview(base: WallPhotoFile, turns: QuarterTurns): Promise<string> {
  if (turns === 0) return base.uri;
  const context = ImageManipulator.manipulate(base.uri).rotate(turns * 90);
  const turned = rotatedSize(base, turns);
  if (Math.max(turned.width, turned.height) > ROTATED_PREVIEW_MAX_DIMENSION) {
    context.resize(
      turned.width >= turned.height
        ? { width: ROTATED_PREVIEW_MAX_DIMENSION }
        : { height: ROTATED_PREVIEW_MAX_DIMENSION },
    );
  }
  const preview = await saveRendered(context, 0.8, turned);
  return preview.uri;
}

/**
 * Pick a wall photo from the library and compress it. Throws only on a real failure.
 *
 * No permission request, on purpose (#5957). The system picker runs outside the
 * app and hands back only the photo the climber chose, and `expo-image-picker`
 * does not check for library access before opening it. Asking first put a
 * whole-library prompt in front of a one-photo pick, and "Don't Allow" then
 * blocked adding a wall at all.
 */
export async function pickWallPhotoFromLibrary(): Promise<WallPhotoLibraryResult> {
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
 * ONLY call this on a binary-and-device that `canPhotographWall()` vouches for.
 * Without `NSCameraUsageDescription`, or on an iOS simulator with no camera,
 * iOS does not deny the request, it terminates the process, so the gate belongs
 * before the call and not inside it.
 */
export async function pickWallPhotoFromCamera(): Promise<WallPhotoCameraResult> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return { outcome: 'denied' };
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return { outcome: 'cancelled' };
  return { outcome: 'picked', photo: await compressAsset(asset) };
}
