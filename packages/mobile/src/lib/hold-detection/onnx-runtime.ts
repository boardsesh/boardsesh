/**
 * The `DetectionRuntime` `@boardsesh/hold-detection` injects, over ONNX Runtime
 * (epic #5346, SW-02).
 *
 * `runDetection(runtime, image, options)` owns the tiling, the letterbox, the
 * decode and the NMS; the only thing it cannot do without the platform is turn
 * one `[1, 3, size, size]` float32 tensor into the model's two output tensors.
 * That is this file, and it is deliberately the whole of the native surface:
 * nothing else in the app imports `onnxruntime-react-native`.
 *
 * Two things are load-bearing and easy to get wrong:
 *
 * 1. **The package installs its JSI bindings at IMPORT time** — its `binding`
 *    module calls `NativeModules.Onnxruntime.install()` on first require, which
 *    throws when the native module is absent (Expo Go, the web build, a binary
 *    predating this PR's fingerprint). So it is required lazily, inside a
 *    try/catch, and the whole feature reports "unavailable" instead of taking
 *    the app down at startup.
 * 2. **Outputs are selected by SHAPE, not by name.** RF-DETR's exporter does not
 *    name its outputs consistently, which is why the manifest schema allows
 *    `outputs.boxes.name` to be null and why `ml/holds/eval.py` and the shared
 *    decode both look for "last dimension 4" and "last dimension = classes".
 *    Matching on a name would work on one export and silently swap the tensors
 *    on the next.
 */

import { Platform } from 'react-native';
import type { DetectionRuntime, RfDetrOutputs } from '@boardsesh/hold-detection';
import { type OrtTensorLike, selectRfDetrOutputs, toSessionPath } from './onnx-outputs';

/** The slice of `onnxruntime-react-native` this adapter uses. */
interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  release?: () => Promise<void>;
  inputNames?: readonly string[];
}

interface OrtModuleLike {
  InferenceSession: {
    create(path: string, options?: { executionProviders?: string[] }): Promise<OrtSessionLike>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
}

/**
 * Execution providers to try, most accelerated first, per platform.
 *
 * Creating a session with an unavailable provider throws rather than falling
 * back, so each entry is attempted in turn and plain CPU closes the list. Which
 * one actually took is reported on the handle, because a benchmark number
 * without it says nothing (#5451 is decided from these numbers).
 *
 * CoreML on iOS and NNAPI on Android are the hardware paths; XNNPACK is the
 * optimised CPU kernel set and is the realistic answer on most Android devices,
 * where NNAPI is deprecated from Android 15 and quantized int8 support has
 * always been vendor-dependent.
 */
const EXECUTION_PROVIDERS: readonly string[] = Platform.select({
  ios: ['coreml', 'xnnpack', 'cpu'],
  android: ['nnapi', 'xnnpack', 'cpu'],
  default: ['cpu'],
});

/** Cached module handle: `null` = not tried yet, `false` = tried and unavailable. */
let cachedModule: OrtModuleLike | false | null = null;

function loadOrt(): OrtModuleLike | null {
  if (cachedModule === false) return null;
  if (cachedModule) return cachedModule;
  try {
    // Lazy require, not a static import: see (1) in the file comment.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // oxlint-disable-next-line import/no-commonjs
    const loaded = require('onnxruntime-react-native') as OrtModuleLike;
    if (!loaded?.InferenceSession || !loaded?.Tensor) {
      cachedModule = false;
      return null;
    }
    cachedModule = loaded;
    return loaded;
  } catch {
    cachedModule = false;
    return null;
  }
}

/** Whether this binary can run a model at all. False on web and on old builds. */
export function isInferenceRuntimeAvailable(): boolean {
  return loadOrt() !== null;
}

export interface HoldDetectionRuntime extends DetectionRuntime {
  /** Which execution provider the session was actually created with. */
  readonly executionProvider: string;
  release(): Promise<void>;
}

/**
 * Open a session over a downloaded model file.
 *
 * Returns null when the runtime is missing or every execution provider failed —
 * the same "no suggestions" answer `ensureModel` gives, for the same reason.
 */
export async function createHoldDetectionRuntime(
  modelUri: string,
  options: { classes?: number } = {},
): Promise<HoldDetectionRuntime | null> {
  const ort = loadOrt();
  if (!ort) return null;
  const classes = options.classes ?? 1;
  const path = toSessionPath(modelUri);

  let session: OrtSessionLike | null = null;
  let provider = '';
  for (const candidate of EXECUTION_PROVIDERS) {
    try {
      session = await ort.InferenceSession.create(path, { executionProviders: [candidate] });
      provider = candidate;
      break;
    } catch {
      // Provider unavailable on this device — try the next one down.
    }
  }
  if (!session) return null;

  const openSession = session;
  const inputName = openSession.inputNames?.[0] ?? 'input';

  return {
    executionProvider: provider,
    async run(input: Float32Array, size: number): Promise<RfDetrOutputs> {
      const tensor = new ort.Tensor('float32', input, [1, 3, size, size]);
      const results = await openSession.run({ [inputName]: tensor });
      const selected = selectRfDetrOutputs(results, classes);
      if (!selected) {
        throw new Error(
          `Hold detector produced no boxes/logits pair (outputs: ${Object.keys(results).join(', ') || 'none'})`,
        );
      }
      return selected;
    },
    async release() {
      try {
        await openSession.release?.();
      } catch {
        // Releasing a session that native already tore down is not a failure.
      }
    },
  };
}
