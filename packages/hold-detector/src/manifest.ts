/**
 * The manifest is the interface between the training harness and anything that
 * runs the model.
 *
 * `ml/holds/publish_model.py` writes it; `ml/holds/model-manifest.schema.json` is
 * its contract. Nothing here hardcodes a model's shape: the input size, the
 * normalisation, the tiling, the thresholds and whether there are masks at all
 * are read from the document, so publishing a new version is a config change and
 * not a deploy of this service.
 *
 * Two rules the schema states and this file enforces, because getting either
 * wrong is silent rather than loud:
 *
 * - **Weights are verified before they are trusted.** Every file carries a
 *   sha256 and a byte count; a mismatch refuses to load rather than running a
 *   model that is not the one whose numbers were published.
 * - **Output tensors are identified by SHAPE, not by name.** RF-DETR's exporter
 *   does not name outputs consistently across versions, so the manifest's
 *   `name` is allowed to be null and a consumer must fall back to shape. Binding
 *   to a name that happens to work today is how this breaks on the next export.
 */

import { createHash } from 'node:crypto';

export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
  dtype: string;
}

export interface Manifest {
  schemaVersion: number;
  version: string;
  family: string;
  config: string;
  input: {
    width: number;
    height: number;
    layout: 'NCHW';
    dtype: 'float32';
    letterbox: 'none' | 'stretch' | 'pad';
    normalization: { mean: number[]; std: number[] };
  };
  outputs: {
    boxes: { name: string | null; format: string };
    logits: { name: string | null; activation: string; classes: number };
    masks?: { name: string | null; activation: string; layout: string; decode: string };
  };
  inference?: {
    longSide: number;
    tiles: { rows: number; cols: number; overlap: number };
    nmsIou: number;
  };
  thresholds: { default: number; sweep: number[] };
  files: ManifestFile[];
  training: Record<string, unknown>;
  eval?: Record<string, unknown>;
  licence: string;
}

/** What this build knows how to run. A manifest outside these fails loudly. */
const SUPPORTED = {
  schemaVersion: 1,
  family: 'rfdetr',
  layout: 'NCHW',
  dtype: 'float32',
  letterbox: new Set(['stretch']),
  logitsActivation: 'sigmoid',
  maskDecode: 'interpolate-then-threshold',
} as const;

export function assertSupported(manifest: Manifest): void {
  const problems: string[] = [];

  if (manifest.schemaVersion !== SUPPORTED.schemaVersion) {
    problems.push(`schemaVersion ${manifest.schemaVersion}, expected ${SUPPORTED.schemaVersion}`);
  }
  if (manifest.family !== SUPPORTED.family) {
    problems.push(`family ${manifest.family}, expected ${SUPPORTED.family}`);
  }
  if (manifest.input.layout !== SUPPORTED.layout) {
    problems.push(`input.layout ${manifest.input.layout}, expected ${SUPPORTED.layout}`);
  }
  if (manifest.input.dtype !== SUPPORTED.dtype) {
    // The int8 export quantises WEIGHTS; the input tensor stays float32.
    problems.push(`input.dtype ${manifest.input.dtype}, expected ${SUPPORTED.dtype}`);
  }
  if (!SUPPORTED.letterbox.has(manifest.input.letterbox)) {
    // `pad` is a different geometry, not a tweak: it would change where every
    // box lands. Refuse rather than silently stretch.
    problems.push(`input.letterbox ${manifest.input.letterbox} is not implemented`);
  }
  if (manifest.outputs.logits.activation !== SUPPORTED.logitsActivation) {
    problems.push(`outputs.logits.activation ${manifest.outputs.logits.activation}`);
  }
  if (manifest.outputs.masks && manifest.outputs.masks.decode !== SUPPORTED.maskDecode) {
    // Interpolating the logits and thresholding afterwards is worth ~17 points
    // of outline quality over the other order; a manifest asking for something
    // else is asking for a decoder this build does not have.
    problems.push(`outputs.masks.decode ${manifest.outputs.masks.decode}`);
  }

  if (problems.length) {
    throw new Error(`manifest ${manifest.version} is not supported by this build: ${problems.join('; ')}`);
  }
}

/** The tiling plan, defaulting to one full-frame pass for a manifest without one. */
export function inferencePlan(manifest: Manifest) {
  return (
    manifest.inference ?? {
      longSide: Math.max(manifest.input.width, manifest.input.height),
      tiles: { rows: 1, cols: 1, overlap: 0 },
      nmsIou: 0.5,
    }
  );
}

/** The weight file to run: int8 if published, else whatever single file there is. */
export function pickWeights(manifest: Manifest): ManifestFile {
  const int8 = manifest.files.find((file) => file.dtype === 'int8');
  const chosen = int8 ?? manifest.files[0];
  if (!chosen) throw new Error(`manifest ${manifest.version} lists no files`);
  return chosen;
}

export function verifyWeights(bytes: Buffer, expected: ManifestFile): void {
  if (bytes.byteLength !== expected.bytes) {
    throw new Error(`${expected.path}: expected ${expected.bytes} bytes, got ${bytes.byteLength}`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected.sha256) {
    throw new Error(`${expected.path}: sha256 ${digest} does not match the manifest's ${expected.sha256}`);
  }
}
