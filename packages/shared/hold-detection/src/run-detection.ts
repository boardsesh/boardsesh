import { toHoldCandidates } from './candidates';
import { decodeRfDetr } from './decode';
import { type LetterboxFit, letterbox, unLetterbox } from './letterbox';
import { mergeTiles } from './nms';
import { type TilePlanOptions, planTiles } from './tiles';
import type { Detection, DetectionRuntime, HoldCandidate, RgbaImage } from './types';

export interface RunDetectionOptions extends TilePlanOptions {
  /** The square side the model consumes. `nano` is 384, `medium` 576. */
  size: number;
  /**
   * Sigmoid score a query has to clear. SW-01 measured this moving F1 by tens of
   * points and landing somewhere different on every corpus (0.05 on the Commons
   * photos, 0.20 on the CC BY retrain's spray walls, 0.3 on The Way Up), which is
   * why the app puts a slider on it rather than shipping a constant.
   */
  scoreThreshold: number;
  fit?: LetterboxFit;
  /**
   * Per-channel normalisation, defaulting to the ImageNet statistics RF-DETR was
   * pretrained with.
   *
   * Exposed rather than assumed because the model manifest PUBLISHES
   * `input.normalization` (SW-01's `ml/holds/model-manifest.schema.json`), and a
   * caller that has read a manifest must be able to honour it. Feeding a graph
   * the wrong mean/std does not fail — it silently shifts every activation, and
   * the only symptom is worse detections.
   */
  mean?: readonly [number, number, number];
  std?: readonly [number, number, number];
  /** IoU above which two tiles are taken to have seen the same hold. */
  nmsIou?: number;
  /** Called after each tile, so a phone can draw a progress bar over four passes. */
  onProgress?: (done: number, total: number) => void;
}

export interface DetectionRun {
  candidates: HoldCandidate[];
  /** The merged detections behind them, in photo pixels — kept for tests and debugging. */
  detections: Detection[];
}

/**
 * Photo in, hold candidates out. The only function most callers need.
 *
 * Everything platform-shaped is injected: `runtime` is the app's ONNX / TFLite
 * session (and `onnxruntime-node` in this package's own tests), and `image` is
 * already-decoded RGBA. This file therefore runs unchanged on a phone, in a
 * browser worker and in Node, which is the whole reason the post-processing lives
 * in `packages/shared/` rather than in the Expo app.
 *
 * Tiles run one at a time on purpose. The alternative is holding several
 * `[1, 3, 576, 576]` float32 tensors and their outputs at once on a device that
 * SW-01 already measured at 391-545 MB peak for a single pass.
 */
export async function runDetection(
  runtime: DetectionRuntime,
  image: RgbaImage,
  options: RunDetectionOptions,
): Promise<DetectionRun> {
  const { size, scoreThreshold, fit = 'stretch', mean, std, nmsIou = 0.5, onProgress, ...planOptions } = options;
  const plan = planTiles(image.width, image.height, planOptions);

  const perTile: Detection[][] = [];
  for (const [tileIndex, rect] of plan.tiles.entries()) {
    const { tensor, mapping } = letterbox(image, rect, { size, fit, mean, std });
    const outputs = await runtime.run(tensor, size);
    perTile.push(
      decodeRfDetr(outputs, { scoreThreshold, tileIndex }).map((detection) => ({
        ...detection,
        box: unLetterbox(detection.box, mapping),
      })),
    );
    onProgress?.(tileIndex + 1, plan.tiles.length);
  }

  const detections = mergeTiles(perTile, { iouThreshold: nmsIou });
  return { candidates: toHoldCandidates(detections), detections };
}
