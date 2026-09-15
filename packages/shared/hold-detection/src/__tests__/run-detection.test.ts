// The orchestrator, and the one test that runs a real model.
//
// `runDetection` is where the injected-runtime contract lives: what the app's
// ONNX / TFLite session is handed, in what layout, and how many times. A stub
// runtime pins the contract in CI; the ONNX test below proves the contract is
// the one a real session actually accepts, on the machine that has the weights.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { runDetection } from '../run-detection';
import type { DetectionRuntime, RfDetrOutputs, RgbaImage } from '../types';

function greyImage(width: number, height: number): RgbaImage {
  const rgba = new Uint8ClampedArray(width * height * 4);
  rgba.fill(120);
  for (let index = 3; index < rgba.length; index += 4) rgba[index] = 255;
  return { width, height, rgba };
}

/** One query, dead centre, at whatever score the caller asks for. */
function oneHold(score: number): RfDetrOutputs {
  return {
    boxes: [0.5, 0.5, 0.25, 0.25],
    boxesShape: [1, 1, 4],
    logits: [Math.log(score / (1 - score))],
    logitsShape: [1, 1, 1],
  };
}

describe('runDetection', () => {
  it('runs once per tile and hands the runtime an NCHW float32 tensor', async () => {
    const seen: { length: number; size: number }[] = [];
    const runtime: DetectionRuntime = {
      run(input, size) {
        seen.push({ length: input.length, size });
        expect(input).toBeInstanceOf(Float32Array);
        expect(input.every((value) => Number.isFinite(value))).toBe(true);
        return oneHold(0.9);
      },
    };

    await runDetection(runtime, greyImage(1200, 900), {
      size: 64,
      scoreThreshold: 0.5,
      longSide: 1024,
      rows: 2,
      cols: 2,
      overlap: 0.15,
    });

    expect(seen).toHaveLength(4);
    expect(seen.every((call) => call.length === 3 * 64 * 64 && call.size === 64)).toBe(true);
  });

  it('reports progress once per tile', async () => {
    const progress: [number, number][] = [];
    await runDetection({ run: () => oneHold(0.9) }, greyImage(800, 600), {
      size: 32,
      scoreThreshold: 0.5,
      rows: 2,
      cols: 3,
      overlap: 0.2,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(progress).toEqual([
      [1, 6],
      [2, 6],
      [3, 6],
      [4, 6],
      [5, 6],
      [6, 6],
    ]);
  });

  it('puts a full-frame detection back in photo pixels', async () => {
    const { candidates } = await runDetection({ run: () => oneHold(0.9) }, greyImage(800, 400), {
      size: 32,
      scoreThreshold: 0.5,
    });
    expect(candidates).toHaveLength(1);
    // The query sits at the centre of the frame and covers a quarter of each side.
    expect(candidates[0].cx).toBeCloseTo(400, 6);
    expect(candidates[0].cy).toBeCloseTo(200, 6);
    expect(candidates[0].r).toBeCloseTo(Math.sqrt((200 * 100) / Math.PI), 6);
  });

  it('merges the same hold seen by four overlapping tiles into one', async () => {
    // Every tile reports a box at its own centre; the four tiles overlap enough
    // that the centre-most pair collides, which is the seam case NMS exists for.
    const { candidates } = await runDetection(
      {
        run: () => ({
          boxes: [0.5, 0.5, 0.9, 0.9],
          boxesShape: [1, 1, 4],
          logits: [2],
          logitsShape: [1, 1, 1],
        }),
      },
      greyImage(400, 400),
      { size: 32, scoreThreshold: 0.5, longSide: 400, rows: 2, cols: 2, overlap: 0.9 },
    );
    expect(candidates.length).toBeLessThan(4);
  });

  it('awaits an async runtime', async () => {
    const { candidates } = await runDetection({ run: async () => Promise.resolve(oneHold(0.9)) }, greyImage(200, 200), {
      size: 16,
      scoreThreshold: 0.5,
    });
    expect(candidates).toHaveLength(1);
  });
});

/**
 * The end-to-end run against the real exported model.
 *
 * It skips unless BOTH the weights and a Node ONNX runtime are on this machine,
 * which in practice means the box that trained the model. CI has neither: the
 * int8 export is 28.7 MB against a 15 MB repo ceiling, and `onnxruntime-node` is
 * a 283 MB install that would be paid by every developer for a test that could
 * never run in CI anyway. `HOLD_DETECTION_ONNX` points at the model; the runtime
 * is imported through a variable specifier so the package can stay free of it.
 *
 *     pnpm --filter @boardsesh/hold-detection add -D onnxruntime-node@^1.29.0
 *     HOLD_DETECTION_ONNX=<...>/model-int8.onnx vp test run --project hold-detection
 *
 * It asserts shape and sanity, NOT parity. `onnxruntime-node` and the Python
 * `onnxruntime` disagree substantially on this int8 graph — see
 * `scripts/capture-fixture-outputs.py` for the measurement — so the numbers a
 * Node session returns are not the numbers `expected-detections.json` holds.
 * Parity is pinned in `parity.test.ts` against recorded Python tensors instead.
 */
interface OnnxSessionModule {
  InferenceSession: {
    create(
      path: string,
      options: object,
    ): Promise<{
      inputNames: string[];
      run(feeds: Record<string, unknown>): Promise<Record<string, { dims: number[]; data: Float32Array }>>;
    }>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
}

async function loadOnnxRuntime(): Promise<OnnxSessionModule | undefined> {
  const specifier = 'onnxruntime-node';
  try {
    return (await import(specifier)) as unknown as OnnxSessionModule;
  } catch {
    return undefined;
  }
}

async function loadJpegDecoder(): Promise<((path: string) => Promise<RgbaImage>) | undefined> {
  const specifier = 'sharp';
  try {
    const sharp = (await import(specifier)) as unknown as {
      default: (path: string) => {
        ensureAlpha(): {
          raw(): {
            toBuffer(options: {
              resolveWithObject: true;
            }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
          };
        };
      };
    };
    return async (path: string) => {
      const { data, info } = await sharp.default(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { width: info.width, height: info.height, rgba: new Uint8ClampedArray(data) };
    };
  } catch {
    return undefined;
  }
}

describe('runDetection against the real ONNX', () => {
  const modelPath = process.env.HOLD_DETECTION_ONNX;

  // `context.skip(reason)`, not an early `return`: a bare return reports a green
  // PASS for a test that ran no model, so CI would read as having exercised the
  // real ONNX on every run. The reason rides the skip rather than a `console.log`
  // — the default reporter does not surface a passing or skipped test's stdout, so
  // a printed line there would be invisible exactly when someone wants it.
  it('finds holds in a fixture photo', async (context) => {
    const runtimeModule = await loadOnnxRuntime();
    const decode = await loadJpegDecoder();
    if (!modelPath || !existsSync(modelPath) || !runtimeModule || !decode) {
      context.skip(
        'real-ONNX run needs all three: ' +
          `model ${modelPath && existsSync(modelPath) ? 'present' : 'missing (set HOLD_DETECTION_ONNX)'}, ` +
          `onnxruntime-node ${runtimeModule ? 'present' : 'missing'}, ` +
          `sharp ${decode ? 'present' : 'missing'}. See this file's comment.`,
      );
      return;
    }

    const session = await runtimeModule.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      intraOpNumThreads: 4,
    });
    const inputName = session.inputNames[0];
    const image = await decode(new URL('../../../../../ml/holds/fixtures/images/1.jpg', import.meta.url).pathname);

    const { candidates } = await runDetection(
      {
        async run(input, size) {
          const results = await session.run({
            [inputName]: new runtimeModule.Tensor('float32', input, [1, 3, size, size]),
          });
          const tensors = Object.values(results);
          const boxes = tensors.find((tensor) => tensor.dims[tensor.dims.length - 1] === 4);
          const logits = tensors.find((tensor) => tensor.dims[tensor.dims.length - 1] !== 4);
          if (!boxes || !logits) throw new Error('unexpected ONNX output shapes');
          return { boxes: boxes.data, boxesShape: boxes.dims, logits: logits.data, logitsShape: logits.dims };
        },
      },
      image,
      { size: 384, scoreThreshold: 0.05, longSide: 1024, rows: 2, cols: 2, overlap: 0.15 },
    );

    // The photo carries 111 hand-labelled holds and the harness scored 152
    // detections on it at this threshold, so anything in the low tens is the
    // pipeline working rather than the model being good.
    expect(candidates.length).toBeGreaterThan(20);
    for (const candidate of candidates) {
      expect(candidate.score).toBeGreaterThanOrEqual(0.05);
      expect(candidate.cx).toBeGreaterThan(-candidate.r);
      expect(candidate.cx).toBeLessThan(image.width + candidate.r);
      expect(candidate.cy).toBeGreaterThan(-candidate.r);
      expect(candidate.cy).toBeLessThan(image.height + candidate.r);
    }
  }, 120_000);
});

describe('runDetection normalisation', () => {
  it('feeds the runtime the mean and std it was given, not the ImageNet default', async () => {
    // The manifest publishes `input.normalization`; a caller that has read one
    // must be able to honour it. Without the pass-through this test sees the
    // ImageNet tensor and the model silently runs on shifted activations.
    const seen: Float32Array[] = [];
    const runtime: DetectionRuntime = {
      run(input) {
        seen.push(Float32Array.from(input));
        return {
          boxes: new Float32Array(0),
          boxesShape: [1, 0, 4],
          logits: new Float32Array(0),
          logitsShape: [1, 0, 1],
        };
      },
    };
    const image: RgbaImage = {
      width: 4,
      height: 4,
      rgba: new Uint8ClampedArray(4 * 4 * 4).fill(255),
    };

    await runDetection(runtime, image, {
      size: 2,
      scoreThreshold: 0.5,
      mean: [0, 0, 0],
      std: [1, 1, 1],
    });

    // A white photo with mean 0 / std 1 is exactly 1.0 everywhere; under the
    // ImageNet default the same pixels come out near 2.2.
    expect(Array.from(seen[0])).toEqual(new Array(3 * 2 * 2).fill(1));
  });
});
