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
 *
 * The resize chains straight off the URI, and the intermediate `ImageRef` is
 * released as soon as the JPEG is on disk. An earlier version rendered the file
 * at FULL resolution first, only to read `width`/`height` off the result — on a
 * 48 MP phone photo that is a ~192 MB bitmap held live through the resize, the
 * save, the file read and the JS decode, still resident when ONNX Runtime
 * allocated its arena. That combination is what the OS watchdog killed. Source
 * dimensions now come from the caller, which already has them: `ImagePicker`
 * reports `width`/`height` on the picked asset.
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

export interface DecodePhotoOptions {
  /** Long side to resize to before decoding. Defaults to `DEFAULT_DECODE_LONG_SIDE`. */
  longSide?: number;
  /**
   * Dimensions of the original file, when the caller already knows them.
   *
   * `ImagePicker` reports these on the picked asset, so the real caller pays
   * nothing for them. Omit them — or pass a zero, which is what the picker does
   * when the system would not say — and the decoded size is reported instead.
   * That is a slightly wrong number on one report field, a far better trade
   * than decoding a 48 MP bitmap to find out.
   */
  sourceWidth?: number;
  sourceHeight?: number;
}

/**
 * Decode `uri` to RGBA, resizing so its long side is at most `longSide`.
 *
 * Throws rather than returning null: unlike the model download, there is no
 * sensible degraded answer for "the user picked a photo and it would not
 * decode", and the one caller (the benchmark screen) wants to show the message.
 */
export async function decodePhotoToRgba(uri: string, options: DecodePhotoOptions = {}): Promise<DecodedPhoto> {
  const { longSide = DEFAULT_DECODE_LONG_SIDE, sourceWidth = 0, sourceHeight = 0 } = options;

  // Resize on the longer edge and let the other follow the aspect ratio —
  // passing both would distort, and the tile planner expects a faithful photo.
  //
  // Without the source dimensions we cannot tell which edge is longer, and
  // decoding to find out is the whole cost being removed here. Constraining
  // BOTH to `longSide` gets to the same place: the manipulator preserves aspect
  // ratio, so the longer edge lands on `longSide` and the shorter comes in
  // under it — the same pixels the informed branch produces.
  const known = sourceWidth > 0 && sourceHeight > 0;
  const resizeTo = known
    ? sourceWidth >= sourceHeight
      ? { width: Math.min(longSide, sourceWidth) }
      : { height: Math.min(longSide, sourceHeight) }
    : { width: longSide, height: longSide };

  const rendered = await ImageManipulator.manipulate(uri).resize(resizeTo).renderAsync();
  let bytes: Uint8Array;
  try {
    // Quality 1: the re-encode is a decode artefact we are forced into, not a
    // size saving, and JPEG ringing around a hold edge is exactly the signal the
    // detector reads.
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 1 });
    bytes = await new File(saved.uri).bytes();
  } finally {
    // Hand the native bitmap back before the JS decode allocates its own copy.
    // `release()` comes from SharedObject and is safe to call more than once.
    rendered.release();
  }

  // `formatAsRGBA` gives four channels, which is the `RgbaImage` contract;
  // `useTArray` keeps `jpeg-js` off Node's Buffer, which does not exist here.
  const decoded = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });

  return {
    width: decoded.width,
    height: decoded.height,
    rgba: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
    // Reporting the decoded size when the caller did not know is honest-ish;
    // a 0 would read as "no photo" in the benchmark JSON.
    sourceWidth: known ? sourceWidth : decoded.width,
    sourceHeight: known ? sourceHeight : decoded.height,
  };
}
