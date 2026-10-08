import { Platform } from 'react-native';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

export type ImageCompressionOptions = {
  /** Longest side, in pixels, the result is allowed to keep. */
  maxDimension: number;
  /** JPEG quality, 0–1. */
  quality: number;
};

/**
 * Resize (if needed) and re-encode a picked image to a small JPEG, returning the
 * local file URI. Resizing a single dimension preserves the aspect ratio; we
 * constrain whichever side is longer. A 0 dimension (the picker couldn't report
 * size) skips the resize but still re-encodes to shrink the file.
 */
export async function compressPickedImage(
  uri: string,
  width: number,
  height: number,
  options: ImageCompressionOptions,
): Promise<string> {
  const compressed = await compressPickedImageWithSize(uri, width, height, options);
  return compressed.uri;
}

/** A saved JPEG and the pixel size the native render actually produced. */
export type CompressedImage = { uri: string; width: number; height: number };

/**
 * `compressPickedImage`, answering with the rendered image's real pixel size as
 * well as its URI.
 *
 * The size comes from the rendered `ImageRef`, after the loader has baked in
 * the EXIF orientation, so it is the size of the picture as it is seen — which
 * the picker's own `width`/`height` are not always (Android can report the
 * sensor's). Zero when the platform could not say.
 */
export async function compressPickedImageWithSize(
  uri: string,
  width: number,
  height: number,
  options: ImageCompressionOptions,
): Promise<CompressedImage> {
  // The long side does not depend on orientation, so the picker's numbers are
  // enough to know WHETHER to resize. On Android they are not enough to know
  // which side to resize: some Android pickers report a portrait photo with the sensor's
  // landscape numbers, and the resize runs on the already-upright bitmap. Sized
  // by the picker, an 8064x6048 report of a portrait photo would come out
  // 5712x7616, 43.5 MP, past the pixel cap the caller asked for.
  const longestSide = Math.max(width, height);
  if (longestSide <= options.maxDimension) {
    return renderAndSave(ImageManipulator.manipulate(uri), options.quality);
  }
  // iOS reports the upright size, so one pass sized by the picker is right
  // there. It must stay one pass: every iOS `manipulate` redraws its source
  // through `ImageFixOrientationTransformer`, so a second pass over an upright
  // 48 MP bitmap would hold another ~195 MB.
  if (Platform.OS !== 'android') {
    const context = ImageManipulator.manipulate(uri);
    context.resize(width >= height ? { width: options.maxDimension } : { height: options.maxDimension });
    return renderAndSave(context, options.quality);
  }
  // Android: decode it upright first and pick the side from what was decoded.
  // `manipulate` over a bitmap ref wraps it without a copy, and the full bitmap
  // is decoded either way; this only keeps it one step longer.
  const upright = await ImageManipulator.manipulate(uri).renderAsync();
  try {
    const context = ImageManipulator.manipulate(upright);
    // An unknown decoded size falls back to the picker's, as before.
    const uprightWidth = upright.width || width;
    const uprightHeight = upright.height || height;
    if (Math.max(uprightWidth, uprightHeight) > options.maxDimension) {
      context.resize(
        uprightWidth >= uprightHeight ? { width: options.maxDimension } : { height: options.maxDimension },
      );
    }
    return await renderAndSave(context, options.quality);
  } finally {
    upright.release();
  }
}

/** Render a manipulator context and save it as a JPEG, with the rendered size. */
async function renderAndSave(
  context: ReturnType<typeof ImageManipulator.manipulate>,
  quality: number,
): Promise<CompressedImage> {
  const image = await context.renderAsync();
  try {
    const result = await image.saveAsync({ compress: quality, format: SaveFormat.JPEG });
    return { uri: result.uri, width: image.width || 0, height: image.height || 0 };
  } finally {
    // Release the native bitmap the rendered ref holds; the saved file URI is a
    // path on disk and stays valid after the ref is gone.
    image.release();
  }
}
