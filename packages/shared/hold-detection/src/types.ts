/**
 * The vocabulary the whole package shares. Nothing here imports anything: these
 * types are the contract between the app's inference runtime (SW-02), this
 * post-processing, and the hold editor (SW-08).
 */

/** A decoded RGBA bitmap. The app decodes it; this package never touches a file. */
export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA, four bytes per pixel, `width * height * 4` long. */
  rgba: Uint8ClampedArray;
}

/**
 * A crop window, in the SOURCE photo's pixels.
 *
 * Deliberately float rather than integer: a tile is planned on the long-side
 * resized copy of the photo and then expressed back in photo pixels, which lands
 * between pixels whenever the scale is not 1. Keeping the fraction is what makes
 * the TypeScript boxes agree with `ml/holds/eval.py`'s to the pixel.
 */
export interface TileRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** An axis-aligned box as `[x0, y0, x1, y1]`. */
export type Box = [number, number, number, number];

/** One detection, in whatever frame the producing step works in. */
export interface Detection {
  box: Box;
  score: number;
  /** Index of the tile this came out of; `mergeTiles` keeps it for debugging. */
  tileIndex: number;
  /**
   * The silhouette this query predicted, as a flat implicitly-closed ring in
   * units of the box's equivalent-circle radius about its centre.
   *
   * Carried on the detection rather than recomputed later because it is decoded
   * in the TILE's frame, where the mask logits live. By the time `mergeTiles` and
   * `unLetterbox` have moved a box into photo coordinates, its mask tensor is
   * out of reach — and the ring is already frame-free, so neither step has to
   * touch it. Undefined for a detection-only model.
   */
  outline?: number[];
}

/**
 * What the hold editor and the wall API consume: a circle plus an optional
 * silhouette.
 *
 * `r` is the equivalent-circle radius of the detection box — the radius of the
 * circle with the box's area — so a hold's placement radius does not depend on
 * which way round the box happened to be. `outline`, when present, is a flat
 * implicitly-closed ring in units of `r`, the
 * `@boardsesh/board-art-geometry` contract the renderer and the outline editor
 * already speak.
 */
export interface HoldCandidate {
  cx: number;
  cy: number;
  r: number;
  score: number;
  outline?: number[];
}

/**
 * The tensors RF-DETR emits, flattened, with their shapes.
 *
 * A detection config emits two. A segmentation config (`mask_source: "model"`)
 * emits a third, per-query mask logits at a quarter of the model's input side,
 * and `masks`/`masksShape` stay undefined for the detection configs so both
 * models decode through the same path.
 */
export interface RfDetrOutputs {
  /** `[1, queries, 4]`, normalised `cx, cy, w, h`. */
  boxes: ArrayLike<number>;
  boxesShape: readonly number[];
  /** `[1, queries, classes]`, raw logits — sigmoid, not softmax (focal loss). */
  logits: ArrayLike<number>;
  logitsShape: readonly number[];
  /** `[1, queries, h, w]`, raw per-query mask logits. Segmentation configs only. */
  masks?: ArrayLike<number>;
  masksShape?: readonly number[];
}

/** The injected inference runtime. One call, one tile. */
export interface DetectionRuntime {
  /**
   * Run the model over one NCHW float32 tensor of shape `[1, 3, size, size]`.
   * Implemented by the app over ONNX Runtime / TFLite, and by the Node tests
   * over `onnxruntime-node`.
   */
  run(input: Float32Array, size: number): Promise<RfDetrOutputs> | RfDetrOutputs;
}
