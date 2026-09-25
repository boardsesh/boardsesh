import { type OutlineOptions, maskToOutline } from './outline';
import type { Box, Detection, RfDetrOutputs } from './types';

export interface DecodeOptions {
  /** Drop everything below this sigmoid score before anything else runs. */
  scoreThreshold: number;
  /** Stamped onto every detection so `mergeTiles` can say where one came from. */
  tileIndex?: number;
  /**
   * Trace each surviving query's mask into an outline, when the model emitted
   * one. Off by default: a detection-only model has no masks to trace, and
   * tracing costs real work per detection.
   */
  outlines?: boolean | OutlineOptions;
}

/**
 * RF-DETR's two output tensors, turned into boxes and scores.
 *
 * Three things about this model that are easy to get wrong, all of them
 * load-bearing and all of them taken from `ml/holds/eval.py`:
 *
 * 1. **The scores are sigmoid, not softmax.** RF-DETR trains with focal loss, so
 *    each class logit is its own independent probability and the per-query score
 *    is the MAX over classes, not a distribution that sums to one. Softmax on a
 *    single-class head would score every query 1.0.
 * 2. **It is a set predictor.** The queries are already one-per-object, so a
 *    single model pass needs no NMS at all. NMS enters only where two TILES saw
 *    the same hold (see `mergeTiles`).
 * 3. **The tensors are identified by shape, not by name.** Exporter versions
 *    disagree about the names; the one whose last dimension is 4 is the boxes.
 *
 * Boxes come out normalised `cx, cy, w, h` and leave as normalised `x0, y0, x1,
 * y1` — still in the model's square frame, because only `unLetterbox` knows
 * which crop produced them.
 */
export function decodeRfDetr(outputs: RfDetrOutputs, options: DecodeOptions): Detection[] {
  const { scoreThreshold, tileIndex = 0, outlines = false } = options;
  const maskPlan = outlines === false ? null : planMasks(outputs);
  const outlineOptions = typeof outlines === 'object' ? outlines : undefined;
  const queries = readQueryCount(outputs);
  const classes = outputs.logitsShape[outputs.logitsShape.length - 1];

  const detections: Detection[] = [];
  for (let query = 0; query < queries; query += 1) {
    let bestLogit = -Infinity;
    for (let klass = 0; klass < classes; klass += 1) {
      const logit = outputs.logits[query * classes + klass];
      if (logit > bestLogit) bestLogit = logit;
    }
    const score = 1 / (1 + Math.exp(-bestLogit));
    if (!(score >= scoreThreshold)) continue;

    const centreX = outputs.boxes[query * 4];
    const centreY = outputs.boxes[query * 4 + 1];
    const width = outputs.boxes[query * 4 + 2];
    const height = outputs.boxes[query * 4 + 3];
    const box: Box = [centreX - width / 2, centreY - height / 2, centreX + width / 2, centreY + height / 2];

    // Traced here, in the tile's own normalised frame, because that is the only
    // place the query index still lines up with a slice of the mask tensor.
    let outline: number[] | undefined;
    if (maskPlan) {
      const start = query * maskPlan.cells;
      outline = maskToOutline(
        {
          logits: subarray(outputs.masks as ArrayLike<number>, start, maskPlan.cells),
          width: maskPlan.width,
          height: maskPlan.height,
        },
        box,
        outlineOptions,
      );
    }
    detections.push(outline ? { box, score, tileIndex, outline } : { box, score, tileIndex });
  }
  return detections;
}

/**
 * The mask tensor's per-query geometry, or null when this model has no masks.
 *
 * Shape is `[1, queries, h, w]`; anything else is a model whose masks this
 * decoder does not understand, and guessing at it would produce silhouettes
 * traced from the wrong numbers. Returning null degrades to circles instead.
 */
function planMasks(outputs: RfDetrOutputs): { width: number; height: number; cells: number } | null {
  const { masks, masksShape } = outputs;
  if (!masks || !masksShape || masksShape.length < 3) return null;
  const width = masksShape[masksShape.length - 1];
  const height = masksShape[masksShape.length - 2];
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height, cells: width * height };
}

/** `subarray` when the runtime handed back a typed array, a copy when it did not. */
function subarray(source: ArrayLike<number>, start: number, length: number): ArrayLike<number> {
  const typed = source as { subarray?: (from: number, to: number) => ArrayLike<number> };
  if (typeof typed.subarray === 'function') return typed.subarray(start, start + length);
  const copy = new Float32Array(length);
  for (let index = 0; index < length; index += 1) copy[index] = source[start + index];
  return copy;
}

function readQueryCount(outputs: RfDetrOutputs): number {
  // Checked before indexing: a 1-D shape would make `length - 2` negative, the
  // lookup `undefined`, and the loop below run zero times — a runtime that
  // flattened its outputs would then read as "the model found no holds" instead
  // of as a bug.
  if (outputs.boxesShape.length < 2 || outputs.logitsShape.length < 2) {
    throw new Error(
      `RF-DETR outputs must be at least 2-D, got boxes [${outputs.boxesShape.join(', ')}] ` +
        `and logits [${outputs.logitsShape.join(', ')}]`,
    );
  }
  const boxQueries = outputs.boxesShape[outputs.boxesShape.length - 2];
  const logitQueries = outputs.logitsShape[outputs.logitsShape.length - 2];
  if (outputs.boxesShape[outputs.boxesShape.length - 1] !== 4) {
    throw new Error(`boxes tensor must end in 4, got shape [${outputs.boxesShape.join(', ')}]`);
  }
  if (boxQueries !== logitQueries) {
    throw new Error(`boxes and logits disagree on the query count: ${boxQueries} vs ${logitQueries}`);
  }
  return boxQueries;
}
