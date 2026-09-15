import type { Box, RgbaImage, TileRect } from './types';

/**
 * How a tile is fitted into the model's square input.
 *
 * `stretch` squashes the tile to the square and is what `ml/holds/eval.py` does
 * (`tile.resize((resolution, resolution))`), so it is the default: the committed
 * parity expectations were produced through it, and changing it would move every
 * box. `contain` is a true letterbox — aspect preserved, the remainder padded —
 * which distorts a hold less on a photo whose aspect is far from square. Both
 * report the same mapping, so nothing downstream has to know which ran.
 */
export type LetterboxFit = 'stretch' | 'contain';

/** ImageNet statistics. RF-DETR normalises with these; see `eval.py`'s `OnnxDetector`. */
export const IMAGENET_MEAN: readonly [number, number, number] = [0.485, 0.456, 0.406];
export const IMAGENET_STD: readonly [number, number, number] = [0.229, 0.224, 0.225];

export interface LetterboxOptions {
  /** The square side the model consumes. */
  size: number;
  fit?: LetterboxFit;
  mean?: readonly [number, number, number];
  std?: readonly [number, number, number];
  /** Grey level the padding is filled with, 0..255. Ignored by `stretch`. */
  padValue?: number;
}

/**
 * Everything `unLetterbox` needs to put a normalised model coordinate back where
 * it came from: which crop of the photo was sampled, and where inside the square
 * that crop actually landed.
 */
export interface LetterboxMapping {
  /** The crop, clipped to the photo. Fractional: see {@link TileRect}. */
  rect: TileRect;
  size: number;
  fit: LetterboxFit;
  /** The content box inside the model square, in model pixels. */
  content: { x: number; y: number; width: number; height: number };
}

export interface LetterboxResult {
  /** NCHW float32, `[1, 3, size, size]`. */
  tensor: Float32Array;
  mapping: LetterboxMapping;
}

/** Triangle (bilinear) filter, support 1. */
function triangle(value: number): number {
  const distance = Math.abs(value);
  return distance < 1 ? 1 - distance : 0;
}

interface AxisWeights {
  /** First source index each output pixel reads, relative to the base window. */
  start: number[];
  weights: number[][];
}

/**
 * Resampling weights for one axis, following Pillow's `ImagingResampleHorizontal`.
 *
 * Pillow scales the filter's support by the reduction factor when it shrinks, so
 * a 4x downscale averages roughly eight source pixels rather than sampling two.
 * A naive two-tap bilinear read instead aliases badly at the scales this package
 * works at — a 1024 px photo down to a 384 px model input — and aliasing on a
 * wall full of small holds throws away exactly the signal the detector needs.
 * Pillow accumulates in 8-bit fixed point for uint8 images, so a single channel
 * here can differ from Pillow's by one level; that is far below the score
 * tolerance the parity tests use.
 *
 * `rectStart` / `rectSize` are the FLOAT window being sampled, `baseStart` /
 * `baseCount` the whole source pixels it spans. A tile planned on the long-side
 * resized copy of a photo lands between photo pixels, and rounding the window to
 * whole pixels instead would shift every box inside it.
 */
function axisWeights(
  rectStart: number,
  rectSize: number,
  baseStart: number,
  baseCount: number,
  outputSize: number,
): AxisWeights {
  const scale = rectSize / outputSize;
  const filterScale = Math.max(1, scale);
  const support = filterScale;
  const start: number[] = [];
  const weights: number[][] = [];

  for (let out = 0; out < outputSize; out += 1) {
    const centre = rectStart + (out + 0.5) * scale - baseStart;
    const min = Math.max(0, Math.floor(centre - support));
    const max = Math.min(baseCount, Math.ceil(centre + support));
    const row: number[] = [];
    let total = 0;
    for (let index = min; index < max; index += 1) {
      const weight = triangle((index - centre + 0.5) / filterScale);
      row.push(weight);
      total += weight;
    }
    // A degenerate window (an output pixel whose whole support falls outside the
    // source) still has to produce a colour rather than NaN, so fall back to the
    // nearest source pixel.
    if (total === 0) {
      start.push(Math.min(baseCount - 1, Math.max(0, Math.round(centre - 0.5))));
      weights.push([1]);
      continue;
    }
    start.push(min);
    weights.push(row.map((weight) => weight / total));
  }
  return { start, weights };
}

/**
 * Sample `rect` out of `image` into the model's square input tensor.
 *
 * ## One stage here, two in `eval.py`
 *
 * This resamples the fractional source rect straight into the square: ONE
 * filtered read, and no intermediate bitmap on a phone already holding a
 * 12-megapixel photo. `ml/holds/eval.py` takes TWO stages — it resizes the whole
 * photo to `long_side`, then resizes each INTEGER crop of that copy to the model
 * side — so it filters the pixels twice and snaps every tile boundary to a whole
 * pixel of the resized copy.
 *
 * The box arithmetic is equivalent (see `planTiles`); the pixel values are not.
 * Two filter passes are not one, and a tile boundary rounded to a whole working
 * pixel sits up to half a working pixel away from the one used here.
 *
 * **Nothing in this repo pins the resample against Pillow.** The parity tests
 * replay the model's RECORDED output tensors, so they check everything after
 * inference and nothing before it. What is claimed for this function is only
 * what its own tests claim: the layout and normalisation of the tensor, the
 * `unLetterbox` round trip, and that a downscale is area-weighted rather than
 * point-sampled. Whether the two stages feed the model measurably different
 * pixels is open, and on the evidence in `capture-fixture-outputs.py` it matters
 * far less than which ONNX runtime executes the graph.
 */
export function letterbox(image: RgbaImage, rect: TileRect, options: LetterboxOptions): LetterboxResult {
  const { size, fit = 'stretch', mean = IMAGENET_MEAN, std = IMAGENET_STD, padValue = 114 } = options;
  if (!Number.isInteger(size) || size <= 0) throw new Error(`letterbox needs a positive integer size, got ${size}`);

  const clippedX0 = Math.max(0, Math.min(rect.x0, image.width - 1));
  const clippedY0 = Math.max(0, Math.min(rect.y0, image.height - 1));
  const clippedX1 = Math.max(clippedX0 + 1, Math.min(rect.x1, image.width));
  const clippedY1 = Math.max(clippedY0 + 1, Math.min(rect.y1, image.height));
  const clipped: TileRect = { x0: clippedX0, y0: clippedY0, x1: clippedX1, y1: clippedY1 };

  // Whole source pixels the float window touches — what the sampler indexes.
  const baseX = Math.floor(clippedX0);
  const baseY = Math.floor(clippedY0);
  const baseWidth = Math.min(image.width, Math.ceil(clippedX1)) - baseX;
  const baseHeight = Math.min(image.height, Math.ceil(clippedY1)) - baseY;

  const cropWidth = clippedX1 - clippedX0;
  const cropHeight = clippedY1 - clippedY0;
  const fitScale = fit === 'contain' ? Math.min(size / cropWidth, size / cropHeight) : 0;
  const contentWidth = fit === 'contain' ? Math.max(1, Math.round(cropWidth * fitScale)) : size;
  const contentHeight = fit === 'contain' ? Math.max(1, Math.round(cropHeight * fitScale)) : size;
  const offsetX = Math.floor((size - contentWidth) / 2);
  const offsetY = Math.floor((size - contentHeight) / 2);

  const plane = size * size;
  const tensor = new Float32Array(3 * plane);
  // Padding is written first so the content pass only has to fill its own box.
  if (contentWidth !== size || contentHeight !== size) {
    for (let channel = 0; channel < 3; channel += 1) {
      tensor.fill((padValue / 255 - mean[channel]) / std[channel], channel * plane, (channel + 1) * plane);
    }
  }

  const horizontal = axisWeights(clippedX0, cropWidth, baseX, baseWidth, contentWidth);
  const vertical = axisWeights(clippedY0, cropHeight, baseY, baseHeight, contentHeight);
  const rowAccumulator = new Float32Array(contentWidth * 3);
  const resampledRows = new Map<number, Float32Array>();

  const resampleRow = (sourceRow: number): Float32Array => {
    const cached = resampledRows.get(sourceRow);
    if (cached) return cached;
    const row = new Float32Array(contentWidth * 3);
    const rowOffset = ((baseY + sourceRow) * image.width + baseX) * 4;
    for (let out = 0; out < contentWidth; out += 1) {
      const weights = horizontal.weights[out];
      const from = horizontal.start[out];
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let step = 0; step < weights.length; step += 1) {
        const pixel = rowOffset + (from + step) * 4;
        red += image.rgba[pixel] * weights[step];
        green += image.rgba[pixel + 1] * weights[step];
        blue += image.rgba[pixel + 2] * weights[step];
      }
      row[out * 3] = red;
      row[out * 3 + 1] = green;
      row[out * 3 + 2] = blue;
    }
    resampledRows.set(sourceRow, row);
    return row;
  };

  for (let out = 0; out < contentHeight; out += 1) {
    rowAccumulator.fill(0);
    const weights = vertical.weights[out];
    const from = vertical.start[out];
    for (let step = 0; step < weights.length; step += 1) {
      const row = resampleRow(from + step);
      for (let index = 0; index < rowAccumulator.length; index += 1) {
        rowAccumulator[index] += row[index] * weights[step];
      }
    }
    // Drop rows the next output pixel cannot reach, so a tall crop does not keep
    // every resampled row alive at once. Deleting from a Map while iterating its
    // own keys is defined behaviour — the iterator visits insertion order and
    // simply skips what has gone — and the vertical windows only ever advance, so
    // nothing removed here is wanted again.
    const nextFrom = out + 1 < contentHeight ? vertical.start[out + 1] : Number.POSITIVE_INFINITY;
    for (const cachedRow of resampledRows.keys()) if (cachedRow < nextFrom) resampledRows.delete(cachedRow);

    const target = (offsetY + out) * size + offsetX;
    for (let column = 0; column < contentWidth; column += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const value = Math.min(255, Math.max(0, rowAccumulator[column * 3 + channel])) / 255;
        tensor[channel * plane + target + column] = (value - mean[channel]) / std[channel];
      }
    }
  }

  return {
    tensor,
    mapping: {
      rect: clipped,
      size,
      fit,
      content: { x: offsetX, y: offsetY, width: contentWidth, height: contentHeight },
    },
  };
}

/**
 * Put a box the model reported in its own normalised 0..1 frame back into photo
 * pixels. The inverse of {@link letterbox}, and the step that makes two tiles'
 * detections comparable.
 */
export function unLetterbox(box: Box, mapping: LetterboxMapping): Box {
  const { rect, size, content } = mapping;
  const rectWidth = rect.x1 - rect.x0;
  const rectHeight = rect.y1 - rect.y0;

  const toX = (value: number) => rect.x0 + ((value * size - content.x) / content.width) * rectWidth;
  const toY = (value: number) => rect.y0 + ((value * size - content.y) / content.height) * rectHeight;

  return [toX(box[0]), toY(box[1]), toX(box[2]), toY(box[3])];
}
