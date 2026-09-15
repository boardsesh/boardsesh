/**
 * The pure half of the ONNX Runtime adapter: everything that can be tested.
 *
 * Split out of `onnx-runtime.ts` for one reason — that file imports `Platform`
 * from `react-native`, and under RN 0.86 `react-native`'s entry is Flow source
 * that Rolldown's collection-time scan parses before any mock applies (see the
 * note on `hooks-dual-write.test.ts` in `packages/mobile/vite.config.ts`). A
 * test that imported it would fail to collect. These two functions are where the
 * bugs would be, so they live where they can be covered.
 */

import type { RfDetrOutputs } from '@boardsesh/hold-detection';

/** The shape of an ONNX Runtime output tensor, as much of it as we read. */
export interface OrtTensorLike {
  data: ArrayLike<number>;
  dims: readonly number[];
}

/**
 * iOS's `InferenceSession.create` wants a filesystem path, not a URL; Android
 * accepts either. `expo-file-system` hands back `file:///…`, so strip it.
 */
export function toSessionPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  return decodeURI(uri.slice('file://'.length));
}

/** The manifest's `outputs.*.name`, either of which may be null (schema allows it). */
export interface RfDetrOutputNames {
  boxes?: string | null;
  logits?: string | null;
}

/**
 * Pick the boxes (`…, 4`) and logits (`…, classes`) tensors out of a result.
 *
 * NAME FIRST, shape as the fallback. The shape rule is unambiguous for every
 * shipped config (`classes` is 1), but a four-class export makes "last dimension
 * 4" describe both tensors, and the tie-break it falls back on is
 * `Object.keys` order — which ONNX Runtime does not promise. So when the manifest
 * published a name for a tensor and the result carries that key, that is the
 * tensor; the manifest parses both names already and discarding them here was the
 * defect. A name that is absent from the result is ignored rather than fatal:
 * RF-DETR's exporter renames outputs between runs, which is why the schema allows
 * null in the first place.
 */
export function selectRfDetrOutputs(
  outputs: Record<string, OrtTensorLike>,
  classes: number,
  names: RfDetrOutputNames = {},
): RfDetrOutputs | null {
  const named = (name: string | null | undefined): OrtTensorLike | null =>
    typeof name === 'string' && name.length > 0 ? (outputs[name] ?? null) : null;

  let boxes = named(names.boxes);
  let logits = named(names.logits);
  // Both names resolving to ONE tensor is not a pair — decoding it as both would
  // read box coordinates as scores. The manifest parser rejects duplicate names
  // too; this is the half that also covers a hand-built options object.
  if (boxes !== null && boxes === logits) return null;
  for (const [key, tensor] of Object.entries(outputs)) {
    // Never let the shape pass re-use the tensor the other name already claimed.
    if (key === names.boxes || key === names.logits) continue;
    const last = tensor.dims[tensor.dims.length - 1];
    if (last === 4 && !boxes) boxes = tensor;
    else if (last === classes && !logits) logits = tensor;
  }
  if (!boxes || !logits) return null;
  return { boxes: boxes.data, boxesShape: boxes.dims, logits: logits.data, logitsShape: logits.dims };
}
