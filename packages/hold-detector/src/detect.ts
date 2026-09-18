/**
 * Photo in, hold candidates out.
 *
 * The pipeline is the one `ml/holds/eval.py` scores and
 * `@boardsesh/hold-detection` already implements: resize the photo's long side,
 * cut it into the manifest's tile grid, stretch each tile into the model's
 * square input, decode RF-DETR's tensors, merge what neighbouring tiles both
 * saw, and hand back circles — plus, for a segmentation model, the silhouette
 * each query predicted.
 *
 * This file owns only the parts that need a runtime and an image decoder;
 * everything about WHAT the numbers mean lives in the shared package, so the
 * app, a browser worker and this service cannot drift apart.
 */

import { type HoldCandidate, decodeRfDetr, mergeTiles, tileWindows, toHoldCandidates } from '@boardsesh/hold-detection';
import { type InferenceSession, Tensor } from 'onnxruntime-node';
import sharp from 'sharp';

import { type Manifest, inferencePlan } from './manifest';

export interface DetectOptions {
  /** Keep detections at or above this score. Defaults to the manifest's. */
  threshold?: number;
  /** Trace outlines when the model has masks. */
  outlines?: boolean;
  /** Mask-grid upsample before tracing. Higher is smoother and slower. */
  upsample?: number;
  /** Douglas-Peucker tolerance in upsampled pixels. */
  tolerance?: number;
}

export interface DetectResult {
  /** Candidates in the ORIGINAL photo's pixels. */
  holds: HoldCandidate[];
  /**
   * The merged detection boxes behind those candidates, same order, in the
   * original photo's pixels.
   *
   * A candidate's `r` is the EQUIVALENT-CIRCLE radius (`sqrt(w*h/pi)`), so a box
   * cannot be recovered from `cx, cy, r` — reconstructing one as `cx +/- r`
   * inflates a square box by 13% and mangles an elongated one. Anything scoring
   * against box ground truth needs these, not the circles.
   */
  boxes: Array<[number, number, number, number]>;
  photo: { width: number; height: number };
  threshold: number;
  stats: { holdCount: number; outlineCount: number; tiles: number };
  timings: { decodeMs: number; inferMs: number; postMs: number };
}

/** Tensors out of one session run, keyed the way the shared decoder wants them. */
function readOutputs(outputs: InferenceSession.OnnxValueMapType) {
  const values = Object.values(outputs) as Tensor[];

  // BY SHAPE, not by name: RF-DETR's exporter does not name outputs
  // consistently, and the manifest permits `name: null` for exactly this reason.
  const boxes = values.find((t) => t.dims.length === 3 && t.dims[t.dims.length - 1] === 4);
  const logits = values.find((t) => t.dims.length === 3 && t.dims[t.dims.length - 1] !== 4);
  const masks = values.find((t) => t.dims.length === 4);
  if (!boxes || !logits) {
    throw new Error(`unexpected model outputs: ${values.map((t) => t.dims.join('x')).join(', ')}`);
  }
  return { boxes, logits, masks };
}

export async function detect(
  session: InferenceSession,
  manifest: Manifest,
  photoBytes: Buffer,
  options: DetectOptions = {},
): Promise<DetectResult> {
  const threshold = options.threshold ?? manifest.thresholds.default;
  const plan = inferencePlan(manifest);
  const { width: inputWidth, height: inputHeight, normalization } = manifest.input;

  const decodeStarted = Date.now();
  const image = sharp(photoBytes, { failOn: 'none' }).rotate();
  const meta = await image.metadata();
  const photoWidth = meta.width ?? 0;
  const photoHeight = meta.height ?? 0;
  if (!photoWidth || !photoHeight) throw new Error('could not read the photo dimensions');

  // The whole pipeline works on the long-side-resized photo; the caller's
  // coordinates are scaled back at the end.
  const scale = plan.longSide / Math.max(photoWidth, photoHeight);
  const workWidth = Math.round(photoWidth * scale);
  const workHeight = Math.round(photoHeight * scale);
  const working = await image.resize(workWidth, workHeight, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const decodeMs = Date.now() - decodeStarted;

  const windows = tileWindows(workWidth, workHeight, plan.tiles);
  const perTile = [];
  let inferMs = 0;

  for (const [index, window] of windows.entries()) {
    const { x0, y0, x1, y1 } = window;
    const tileWidth = x1 - x0;
    const tileHeight = y1 - y0;

    // Crop out of the raw RGB buffer and stretch into the model's square input.
    const tileBytes = await sharp(working, { raw: { width: workWidth, height: workHeight, channels: 3 } })
      .extract({ left: x0, top: y0, width: tileWidth, height: tileHeight })
      .resize(inputWidth, inputHeight, { fit: 'fill' })
      .raw()
      .toBuffer();

    const tensor = toInputTensor(tileBytes, inputWidth, inputHeight, normalization);
    const started = Date.now();
    const outputs = await session.run({ [session.inputNames[0]]: tensor });
    inferMs += Date.now() - started;

    const { boxes, logits, masks } = readOutputs(outputs);
    const detections = decodeRfDetr(
      {
        boxes: boxes.data as Float32Array,
        boxesShape: boxes.dims,
        logits: logits.data as Float32Array,
        logitsShape: logits.dims,
        ...(masks && options.outlines ? { masks: masks.data as Float32Array, masksShape: masks.dims } : {}),
      },
      {
        scoreThreshold: threshold,
        tileIndex: index,
        // A tile is not square; without its real size the traced ring is
        // stretched by the tile's aspect ratio.
        outlines: options.outlines
          ? {
              tileWidth,
              tileHeight,
              upsample: options.upsample ?? 4,
              ...(options.tolerance !== undefined ? { tolerance: options.tolerance } : {}),
            }
          : false,
      },
    );

    // Normalised tile coordinates -> working-photo pixels.
    perTile.push(
      detections.map((detection) => ({
        ...detection,
        box: [
          x0 + detection.box[0] * tileWidth,
          y0 + detection.box[1] * tileHeight,
          x0 + detection.box[2] * tileWidth,
          y0 + detection.box[3] * tileHeight,
        ] as [number, number, number, number],
      })),
    );
  }

  const postStarted = Date.now();
  const merged = mergeTiles(perTile, { iouThreshold: plan.nmsIou });
  const holds = toHoldCandidates(merged).map((hold) => ({
    ...hold,
    // Back into the original photo's pixels. The outline is in units of r, so it
    // needs no scaling — which is the point of storing it that way.
    cx: hold.cx / scale,
    cy: hold.cy / scale,
    r: hold.r / scale,
  }));
  const boxes = merged.map(
    (detection) =>
      [detection.box[0] / scale, detection.box[1] / scale, detection.box[2] / scale, detection.box[3] / scale] as [
        number,
        number,
        number,
        number,
      ],
  );
  const postMs = Date.now() - postStarted;

  return {
    holds,
    boxes,
    photo: { width: photoWidth, height: photoHeight },
    threshold,
    stats: {
      holdCount: holds.length,
      outlineCount: holds.filter((hold) => hold.outline?.length).length,
      tiles: windows.length,
    },
    timings: { decodeMs, inferMs, postMs },
  };
}

/** Raw interleaved RGB -> normalised NCHW float32. */
function toInputTensor(
  rgb: Buffer,
  width: number,
  height: number,
  normalization: { mean: number[]; std: number[] },
): Tensor {
  const pixels = width * height;
  const data = new Float32Array(3 * pixels);
  const { mean, std } = normalization;
  for (let index = 0; index < pixels; index += 1) {
    const source = index * 3;
    data[index] = (rgb[source] / 255 - mean[0]) / std[0];
    data[pixels + index] = (rgb[source + 1] / 255 - mean[1]) / std[1];
    data[2 * pixels + index] = (rgb[source + 2] / 255 - mean[2]) / std[2];
  }
  return new Tensor('float32', data, [1, 3, height, width]);
}
