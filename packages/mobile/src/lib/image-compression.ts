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
  const context = ImageManipulator.manipulate(uri);
  const longestSide = Math.max(width, height);
  if (longestSide > options.maxDimension) {
    if (width >= height) {
      context.resize({ width: options.maxDimension });
    } else {
      context.resize({ height: options.maxDimension });
    }
  }
  const image = await context.renderAsync();
  try {
    const result = await image.saveAsync({ compress: options.quality, format: SaveFormat.JPEG });
    return { uri: result.uri, width: image.width || 0, height: image.height || 0 };
  } finally {
    // Release the native bitmap the rendered ref holds; the saved file URI is a
    // path on disk and stays valid after the ref is gone.
    image.release();
  }
}
