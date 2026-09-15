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

/** Pick the boxes (`…, 4`) and logits (`…, classes`) tensors out of a result. */
export function selectRfDetrOutputs(outputs: Record<string, OrtTensorLike>, classes: number): RfDetrOutputs | null {
  let boxes: OrtTensorLike | null = null;
  let logits: OrtTensorLike | null = null;
  for (const tensor of Object.values(outputs)) {
    const last = tensor.dims[tensor.dims.length - 1];
    if (last === 4 && !boxes) boxes = tensor;
    else if (last === classes && !logits) logits = tensor;
  }
  // `classes` is 1 for every shipped config, so a `[1, queries, 1]` logits
  // tensor and a `[1, queries, 4]` boxes tensor are unambiguous. The guard
  // matters for the pathological export where both are 4: the first match wins
  // as boxes and the second as logits, which is the order RF-DETR emits them in.
  if (!boxes || !logits) return null;
  return { boxes: boxes.data, boxesShape: boxes.dims, logits: logits.data, logitsShape: logits.dims };
}
