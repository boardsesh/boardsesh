/**
 * `@boardsesh/hold-detection` — the platform-free half of on-device hold
 * detection: tiling, preprocessing, decoding RF-DETR's two tensors, merging what
 * several tiles saw, and handing back circles the hold editor can draw.
 *
 * Pure TypeScript. No React, no React Native, no DOM: the inference runtime and
 * the image decoder are injected, so the same code runs in the Expo app, in a
 * browser worker and under Node's test runner. What the model itself is, where
 * it comes from and what it scores are SW-01 (`ml/holds/README.md`) and SW-02.
 *
 * The Python this has to agree with is `ml/holds/eval.py` and
 * `ml/holds/common.py`; the agreement is pinned by the parity tests in
 * `src/__tests__/parity.test.ts` against `ml/holds/fixtures/expected-detections.json`.
 */
export { toHoldCandidates } from './candidates';
export { COLOUR_DESCRIPTOR_LENGTH, HUE_BINS, type ColourDescriptor, describeColour, rgbToLab } from './colour';
export { type DecodeOptions, decodeRfDetr } from './decode';
export {
  IMAGENET_MEAN,
  IMAGENET_STD,
  type LetterboxFit,
  type LetterboxMapping,
  type LetterboxOptions,
  type LetterboxResult,
  letterbox,
  unLetterbox,
} from './letterbox';
export { type MergeOptions, boxIou, mergeTiles, nms } from './nms';
export { type DetectionRun, type RunDetectionOptions, runDetection } from './run-detection';
export { DEFAULT_TILE_PLAN, type TileGrid, type TilePlan, type TilePlanOptions, planTiles, tileWindows } from './tiles';
export type { Box, Detection, DetectionRuntime, HoldCandidate, RfDetrOutputs, RgbaImage, TileRect } from './types';
