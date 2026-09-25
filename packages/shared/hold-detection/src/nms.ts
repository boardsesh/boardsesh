import type { Box, Detection } from './types';

/** Intersection over union of two axis-aligned boxes. */
export function boxIou(a: Box, b: Box): number {
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const intersection =
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Plain greedy non-maximum suppression, class-agnostic: a hold is a hold.
 *
 * Port of `nms` in `ml/holds/common.py`. Ordering is by descending score; two
 * float sigmoid scores colliding exactly is not something either language
 * promises to break the same way, and no fixture contains such a pair. Returns
 * the indices that survive, in the order they were kept.
 */
export function nms(boxes: Box[], scores: number[], iouThreshold: number): number[] {
  const order = boxes.map((_, index) => index).sort((left, right) => scores[right] - scores[left]);
  const suppressed = new Uint8Array(boxes.length);
  const keep: number[] = [];

  for (const candidate of order) {
    if (suppressed[candidate] === 1) continue;
    keep.push(candidate);
    for (const other of order) {
      if (other === candidate || suppressed[other] === 1) continue;
      // `<=` keeps a box exactly AT the threshold, matching common.py's
      // `ious <= iou_threshold` survivor filter.
      if (boxIou(boxes[candidate], boxes[other]) > iouThreshold) suppressed[other] = 1;
    }
  }
  return keep;
}

export interface MergeOptions {
  /** IoU above which two tiles are taken to have seen the same hold. */
  iouThreshold?: number;
}

/**
 * Fold every tile's detections into one list.
 *
 * A single full-frame pass needs nothing done to it — RF-DETR is a set predictor
 * — so this exists for the overlap seams: `planTiles` deliberately overlaps its
 * windows so a hold on a seam is whole in at least one tile, which means the
 * neighbouring tile saw it too and clipped.
 *
 * The survivor is the higher-scoring box, exactly as in `eval.py`. Issue #5439
 * floated preferring the detection farther from a tile edge instead; that is NOT
 * implemented, because the Python this package has to agree with does not do it
 * and there is no fixture that could tell a better rule from a worse one. When a
 * corpus with seam ground truth exists, this is where the change goes.
 */
export function mergeTiles(perTile: readonly Detection[][], options: MergeOptions = {}): Detection[] {
  const { iouThreshold = 0.5 } = options;
  const all = perTile.flat();
  if (all.length <= 1) return [...all];
  return nms(
    all.map((detection) => detection.box),
    all.map((detection) => detection.score),
    iouThreshold,
  ).map((index) => all[index]);
}
