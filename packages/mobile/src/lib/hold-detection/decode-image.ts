/**
 * A photo on disk turned into the decoded RGBA `@boardsesh/hold-detection` wants.
 *
 * The shared package never touches a file — `runDetection(runtime, image, …)`
 * takes pixels — so somebody has to decode, and on a phone that is harder than
 * it sounds. `expo-image-manipulator` resizes and re-encodes natively but only
 * ever hands back an encoded JPEG/PNG/WebP; nothing in the Expo surface returns
 * raw pixels. So: resize natively (fast, and it is the only step that has to
 * handle a 12 MP photo), then decode the small JPEG in JS.
 *
 * `jpeg-js` is pure JS and BSD-3-Clause, and it is only ever fed an image that
 * has already been shrunk to `longSide`, which is what keeps a JS baseline
 * decoder from being the wrong tool: 1280 x 960 is 1.2 M pixels, not 12 M.
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { decode as decodeJpeg } from 'jpeg-js';
import type { RgbaImage } from '@boardsesh/hold-detection';

/**
 * Long side the photo is resized to before decoding.
 *
 * 1280 is `DEFAULT_TILE_PLAN.longSide` in the shared package, so the pixels the
 * model sees here are the pixels it will see in the real flow.
 */
export const DEFAULT_DECODE_LONG_SIDE = 1280;

export interface DecodedPhoto extends RgbaImage {
  /** Dimensions of the ORIGINAL file, before the resize — reported by the benchmark. */
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Decode `uri` to RGBA, resizing so its long side is at most `longSide`.
 *
 * Throws rather than returning null: unlike the model download, there is no
 * sensible degraded answer for "the user picked a photo and it would not
 * decode", and the one caller (the benchmark screen) wants to show the message.
 */
export async function decodePhotoToRgba(
  uri: string,
  longSide: number = DEFAULT_DECODE_LONG_SIDE,
): Promise<DecodedPhoto> {
  // One decode of the full-size file: the ImageRef is then reused as the source
  // of the resize, so a 12 MP photo is not read off disk and decoded twice.
  const loaded = await ImageManipulator.manipulate(uri).renderAsync();
  const sourceWidth = loaded.width;
  const sourceHeight = loaded.height;

  // Resize on the longer edge and let the other follow the aspect ratio —
  // passing both would distort, and the tile planner expects a faithful photo.
  const landscape = sourceWidth >= sourceHeight;
  const rendered = await ImageManipulator.manipulate(loaded)
    .resize(landscape ? { width: Math.min(longSide, sourceWidth) } : { height: Math.min(longSide, sourceHeight) })
    .renderAsync();
  // Quality 1: the re-encode is a decode artefact we are forced into, not a
  // size saving, and JPEG ringing around a hold edge is exactly the signal the
  // detector reads.
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 1 });

  const bytes = await new File(saved.uri).bytes();
  // `formatAsRGBA` gives four channels, which is the `RgbaImage` contract;
  // `useTArray` keeps `jpeg-js` off Node's Buffer, which does not exist here.
  const decoded = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });

  return {
    width: decoded.width,
    height: decoded.height,
    rgba: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
    sourceWidth,
    sourceHeight,
  };
}
