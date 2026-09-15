/**
 * The hold-detector model manifest, as the app is willing to trust it.
 *
 * The authority is `ml/holds/model-manifest.schema.json` (SW-01, PR #5473),
 * which `ml/holds/publish_model.py` validates against before it writes
 * `models/hold-detector/<version>/manifest.json` into the public media bucket.
 * This file re-states the subset the app actually reads, as a runtime check
 * rather than a type assertion: the manifest is fetched over the network from a
 * mutable key, so `as ModelManifest` would be a promise the network never made.
 *
 * Deliberately lenient about everything else. `additionalProperties` is true in
 * the schema and fields get added over time (`eval` already is optional), so an
 * unknown key is normal and must never turn into a rejected manifest — only a
 * missing or malformed field the app depends on does.
 */

/** What the ONNX graph consumes. `width`/`height` are the TRAINED input size. */
export interface ModelManifestInput {
  width: number;
  height: number;
  layout: 'NCHW';
  dtype: 'float32';
  letterbox: 'none' | 'stretch' | 'pad';
  normalization: { mean: [number, number, number]; std: [number, number, number] };
}

/**
 * How to find the two RF-DETR tensors in the session's outputs.
 *
 * `name` is nullable on purpose: RF-DETR's exporter does not name outputs
 * consistently, so `ml/holds/eval.py` and `@boardsesh/hold-detection` both pick
 * the tensors by SHAPE — last dimension 4 is boxes, last dimension `classes` is
 * logits. The runtime adapter does the same; `name` is only ever a hint.
 */
export interface ModelManifestOutputs {
  boxes: { name: string | null; format: 'cxcywh-normalized' };
  logits: { name: string | null; activation: 'sigmoid'; classes: number };
}

export interface ModelManifestFile {
  /** Key relative to `models/hold-detector/<version>/`. */
  path: string;
  bytes: number;
  sha256: string;
  dtype: 'int8' | 'fp32';
}

export interface ModelManifest {
  schemaVersion: 1;
  version: string;
  family: string;
  config: string;
  input: ModelManifestInput;
  outputs: ModelManifestOutputs;
  thresholds: { default: number; sweep: number[] };
  files: ModelManifestFile[];
  licence: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) && number > 0 ? number : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function triple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const numbers = value.map(finiteNumber);
  if (numbers.some((entry) => entry === null)) return null;
  return [numbers[0] as number, numbers[1] as number, numbers[2] as number];
}

function parseInput(value: unknown): ModelManifestInput | null {
  if (!isRecord(value)) return null;
  const width = positiveInteger(value.width);
  const height = positiveInteger(value.height);
  if (width === null || height === null) return null;
  // The decode in @boardsesh/hold-detection is written against exactly one
  // preprocessing contract. A manifest that announced a different layout or
  // dtype would be describing a graph this app cannot feed, so it is rejected
  // rather than coerced.
  if (value.layout !== 'NCHW' || value.dtype !== 'float32') return null;
  if (value.letterbox !== 'none' && value.letterbox !== 'stretch' && value.letterbox !== 'pad') return null;
  if (!isRecord(value.normalization)) return null;
  const mean = triple(value.normalization.mean);
  const std = triple(value.normalization.std);
  if (mean === null || std === null) return null;
  return { width, height, layout: 'NCHW', dtype: 'float32', letterbox: value.letterbox, normalization: { mean, std } };
}

function parseOutputs(value: unknown): ModelManifestOutputs | null {
  if (!isRecord(value) || !isRecord(value.boxes) || !isRecord(value.logits)) return null;
  const { boxes, logits } = value;
  if (boxes.format !== 'cxcywh-normalized' || logits.activation !== 'sigmoid') return null;
  const classes = positiveInteger(logits.classes);
  if (classes === null) return null;
  const boxesName = typeof boxes.name === 'string' ? boxes.name : null;
  const logitsName = typeof logits.name === 'string' ? logits.name : null;
  return {
    boxes: { name: boxesName, format: 'cxcywh-normalized' },
    logits: { name: logitsName, activation: 'sigmoid', classes },
  };
}

function parseThresholds(value: unknown): { default: number; sweep: number[] } | null {
  if (!isRecord(value)) return null;
  const fallback = finiteNumber(value.default);
  if (fallback === null || fallback < 0 || fallback > 1) return null;
  if (!Array.isArray(value.sweep)) return null;
  const sweep: number[] = [];
  for (const entry of value.sweep) {
    const number = finiteNumber(entry);
    if (number === null || number < 0 || number > 1) return null;
    sweep.push(number);
  }
  return { default: fallback, sweep };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function parseFiles(value: unknown): ModelManifestFile[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const files: ModelManifestFile[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const path = nonEmptyString(entry.path);
    const bytes = positiveInteger(entry.bytes);
    const sha256 = typeof entry.sha256 === 'string' && SHA256_HEX.test(entry.sha256) ? entry.sha256 : null;
    if (path === null || bytes === null || sha256 === null) return null;
    if (entry.dtype !== 'int8' && entry.dtype !== 'fp32') return null;
    // A path that climbs out of the version directory would write the model
    // somewhere the store never evicts. The manifest is a remote, mutable file;
    // treat its paths as untrusted input.
    if (path.includes('..') || path.startsWith('/')) return null;
    files.push({ path, bytes, sha256, dtype: entry.dtype });
  }
  return files;
}

/**
 * Validate a parsed `manifest.json` body, or return null.
 *
 * Null, never a throw: every caller in this feature degrades to "no suggestions,
 * place the holds by hand", and an exception crossing into UI code would turn a
 * bad deploy of a JSON file into a crash.
 */
export function parseModelManifest(value: unknown): ModelManifest | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  const version = nonEmptyString(value.version);
  const family = nonEmptyString(value.family);
  const config = nonEmptyString(value.config);
  const licence = nonEmptyString(value.licence);
  const input = parseInput(value.input);
  const outputs = parseOutputs(value.outputs);
  const thresholds = parseThresholds(value.thresholds);
  const files = parseFiles(value.files);
  if (
    version === null ||
    family === null ||
    config === null ||
    licence === null ||
    input === null ||
    outputs === null ||
    thresholds === null ||
    files === null
  ) {
    return null;
  }
  return { schemaVersion: 1, version, family, config, input, outputs, thresholds, files, licence };
}

/**
 * The file the app downloads: the int8 export.
 *
 * int8 rather than fp32 because that is the only one that fits a phone —
 * 31.3 MB against 107 MB for the same `nano-untiled-1024` weights (#5434). A
 * manifest that ships only fp32 is a manifest for the server path (#5451), so
 * this returns null and the caller reports "no model" instead of pulling 107 MB
 * over someone's gym wifi.
 */
export function selectInt8File(manifest: ModelManifest): ModelManifestFile | null {
  return manifest.files.find((file) => file.dtype === 'int8') ?? null;
}
