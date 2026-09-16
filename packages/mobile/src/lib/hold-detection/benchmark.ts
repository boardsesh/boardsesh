/**
 * The measurement behind the on-device-vs-server decision (#5451).
 *
 * SW-01 measured `nano-untiled-1024` at 987 MB peak for one 768 px pass on
 * DESKTOP ONNX Runtime — double the 500 MB phone budget — and separately found
 * that the Node and Python runtimes already disagree on the int8 graph by five
 * detections on one fixture photo. Both facts say the same thing: the desktop
 * numbers cannot stand in for phone numbers, and nothing here should be quoted
 * from anywhere but a device.
 *
 * So this runs the published model at three input sizes on one real photo and
 * reports, per size, the median of three passes, the detection count at the
 * manifest's own default threshold and at the low threshold, and what the JS heap
 * did. It is
 * an instrument, not a feature: keep it boring.
 */

import type { DetectionRuntime, HoldCandidate } from '@boardsesh/hold-detection';
import { runDetection } from '@boardsesh/hold-detection';

/**
 * Input sizes to sweep.
 *
 * 768 is what `nano-untiled-1024` was trained at (the manifest's `input.width`),
 * so it is the accuracy ceiling; 640 and 512 are the two steps down that would
 * buy memory and latency if the top one does not fit. The letterbox in the
 * shared package stretches the frame to whatever size it is handed, so a smaller
 * input needs no re-export — it is the same graph fed a smaller tensor.
 *
 * ASCENDING, cheapest first, and that order is load-bearing. The 987 MB figure
 * above is for 768, against a 500 MB budget, so 768 is the size most likely to
 * get the process killed — and a watchdog kill takes the whole report with it,
 * including the 512 and 640 numbers that were already measured. Running upwards
 * means a device that cannot survive the top size still reports the two below
 * it, which is most of what #5451 needs. Descending order produced nothing at
 * all on a 48 MP phone.
 */
export const BENCHMARK_INPUT_SIZES = [512, 640, 768] as const;

/**
 * Nominal floor for the second detection count, for the confidence slider (#5441).
 *
 * A FLOOR, not the threshold that is used: `lowThresholdFor` takes the smaller of
 * this and the manifest default, because a manifest shipping a default below 0.3
 * would otherwise make the two counts identical and the "@ 0.30" column dead.
 */
export const BENCHMARK_LOW_THRESHOLD = 0.3;

/** The low threshold actually decoded at, given a manifest default. */
export function lowThresholdFor(defaultThreshold: number): number {
  return Math.min(BENCHMARK_LOW_THRESHOLD, defaultThreshold);
}

/** Passes per size. Three is enough for a median and cheap enough to sit through. */
export const BENCHMARK_RUNS_PER_SIZE = 3;

export interface BenchmarkSizeResult {
  size: number;
  /** Median wall-clock of `BENCHMARK_RUNS_PER_SIZE` passes, milliseconds. */
  p50Ms: number;
  /** Every pass, in order — a first-run outlier is the interesting part. */
  runsMs: number[];
  /** Candidates at the manifest's shipped default threshold. */
  detectionsAtDefault: number;
  /** Candidates at the report's `lowThreshold`. */
  detectionsAtLow: number;
  /**
   * Change in the Hermes JS heap across the size's passes, bytes, or null when
   * the runtime will not say.
   *
   * NOT the number that decides anything. ONNX Runtime allocates its arena in
   * NATIVE memory, which no JS-visible counter on either platform includes
   * (`performance.memory` does not exist in Hermes). The real peak comes from
   * Xcode Instruments' Allocations or Android Studio's Memory Profiler against
   * this same screen; this field only catches the JS side leaking tensors.
   */
  jsHeapDeltaBytes: number | null;
}

/** A size the runtime refused, kept so one rejection does not lose the sweep. */
export interface BenchmarkSizeFailure {
  size: number;
  /** The runtime's own message — an ORT shape-mismatch names the static axis. */
  error: string;
}

export interface BenchmarkReport {
  modelVersion: string;
  modelConfig: string;
  /**
   * The execution provider the session was ASKED for, not necessarily the one
   * that ran the graph: ONNX Runtime silently falls back to CPU for any subgraph
   * a provider cannot take, and nothing in the JS API reports which kernels went
   * where. Read it as "the most accelerated provider that would open the model".
   */
  requestedExecutionProvider: string;
  defaultThreshold: number;
  /** The second threshold these counts were taken at — see `lowThresholdFor`. */
  lowThreshold: number;
  /** What the frame was actually put through — copied into the JSON blob. */
  preprocessing: { fit: 'stretch' | 'contain'; mean: number[]; std: number[] };
  photo: { width: number; height: number; sourceWidth: number; sourceHeight: number };
  sizes: BenchmarkSizeResult[];
  /** Sizes that threw, in sweep order. Empty on a clean run. */
  failures: BenchmarkSizeFailure[];
}

/** Median of a small sample. Even counts take the mean of the middle pair. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Hermes' JS heap size in bytes, or null.
 *
 * `HermesInternal.getInstrumentedStats()` is a debug surface that can be absent
 * or renamed; every read is guarded and a missing counter reports null rather
 * than a zero that would read as "nothing allocated".
 */
export function readJsHeapBytes(): number | null {
  try {
    const hermes = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => Record<string, unknown> } })
      .HermesInternal;
    const stats = hermes?.getInstrumentedStats?.();
    const allocated = stats?.js_allocatedBytes ?? stats?.js_heapSize;
    return typeof allocated === 'number' && Number.isFinite(allocated) ? allocated : null;
  } catch {
    return null;
  }
}

export interface BenchmarkInput {
  runtime: DetectionRuntime;
  image: { width: number; height: number; rgba: Uint8ClampedArray; sourceWidth: number; sourceHeight: number };
  modelVersion: string;
  modelConfig: string;
  /** What `createHoldDetectionRuntime` asked for; see the field on the report. */
  requestedExecutionProvider: string;
  defaultThreshold: number;
  /**
   * Preprocessing, straight off the manifest — `letterboxFitFor(manifest.input)`
   * and `manifest.input.normalization`.
   *
   * Required, not optional with a default. Both have defaults in the shared
   * package (`stretch`, ImageNet), and a benchmark that silently used them while
   * the manifest published something else would report latency and detection
   * counts for a preprocessing the model was never exported for — which is the
   * one thing this screen must not do, since #5451 is decided from its numbers.
   */
  fit: 'stretch' | 'contain';
  mean: readonly [number, number, number];
  std: readonly [number, number, number];
  sizes?: readonly number[];
  runsPerSize?: number;
  /**
   * Close the current session and open a fresh one, called between sizes.
   *
   * ONNX Runtime's arena lives in native memory and only ever grows: a session
   * that has run 512 and 640 carries both of their high-water marks into 768,
   * which is the size already known to sit near the budget. Recycling means each
   * size is measured on its own arena rather than on the previous sizes'
   * leftovers — more honest numbers, and the difference between reporting 768
   * and being killed during it.
   *
   * Optional: tests pass a single fake runtime and omit this. Returning null is
   * taken as "the device could not reopen the model", which ends the sweep with
   * the sizes already measured rather than throwing them away.
   */
  recycleRuntime?: () => Promise<DetectionRuntime | null>;
  /**
   * One size finished — called with the run so far, before the next size starts.
   *
   * This is the only chance to keep a result. A watchdog termination is not an
   * exception: it does not unwind, so nothing after the sweep runs and no React
   * state survives. The largest size is the one that triggers it, so without a
   * flush here the sizes that DID fit are lost along with the one that did not.
   * Flush to disk from this callback.
   *
   * Intentionally synchronous. An `await` here would hand control back to the
   * runtime between sizes with the partial unwritten, which is precisely the
   * window being closed.
   */
  onSizeComplete?: (sizes: readonly BenchmarkSizeResult[], failures: readonly BenchmarkSizeFailure[]) => void;
  /** Progress for the screen: which size, which pass. */
  onProgress?: (size: number, run: number, totalRuns: number) => void;
  /** Injected in tests so a fake clock is possible; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Run the sweep.
 *
 * Detections are counted from ONE pass per threshold pair rather than re-running
 * the model: the threshold is applied when the queries are decoded, so a second
 * pass at the low threshold would be the same tensors filtered differently. The
 * timed passes use the low threshold, so a latency number is never the cheaper of
 * the two.
 *
 * A size that throws is RECORDED and the sweep continues. `ml/holds/export.py`
 * exports at a fixed `shape=(resolution, resolution)` with no `dynamic_axes`, so
 * ONNX Runtime rejects every size below the trained 768 until the graph is
 * re-exported — and aborting on the first rejection would throw away the 768
 * numbers that #5451 is actually decided from.
 */
export async function runBenchmark(input: BenchmarkInput): Promise<BenchmarkReport> {
  const {
    runtime: initialRuntime,
    image,
    sizes = BENCHMARK_INPUT_SIZES,
    runsPerSize = BENCHMARK_RUNS_PER_SIZE,
    defaultThreshold,
    fit,
    mean,
    std,
    recycleRuntime,
    onSizeComplete,
    onProgress,
    now = Date.now,
  } = input;
  let runtime = initialRuntime;

  const lowThreshold = lowThresholdFor(defaultThreshold);
  const results: BenchmarkSizeResult[] = [];
  const failures: BenchmarkSizeFailure[] = [];
  for (const size of sizes) {
    const heapBefore = readJsHeapBytes();
    const runsMs: number[] = [];
    let lastCandidates: HoldCandidate[] = [];
    try {
      for (let run = 0; run < runsPerSize; run += 1) {
        onProgress?.(size, run + 1, runsPerSize);
        const startedAt = now();
        const { candidates } = await runDetection(runtime, image, {
          size,
          scoreThreshold: lowThreshold,
          fit,
          mean,
          std,
        });
        runsMs.push(now() - startedAt);
        lastCandidates = candidates;
      }
    } catch (error) {
      failures.push({ size, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const heapAfter = readJsHeapBytes();
    results.push({
      size,
      p50Ms: median(runsMs),
      runsMs,
      // Decoded once at the low threshold and counted twice: the high-threshold
      // set is a strict subset, so filtering is exactly what a second pass with
      // `scoreThreshold: defaultThreshold` would have produced.
      detectionsAtDefault: lastCandidates.filter((candidate) => candidate.score >= defaultThreshold).length,
      detectionsAtLow: lastCandidates.length,
      jsHeapDeltaBytes: heapBefore !== null && heapAfter !== null ? heapAfter - heapBefore : null,
    });

    // Flush before the next size opens its arena. On the device that reported
    // this, 512 completes and 768 kills the process — so this call is what
    // decides whether the tester ends up with a 512 number or with nothing.
    onSizeComplete?.(results, failures);

    // Drop this size's arena before the next, larger one opens. Skipped after
    // the final size: the caller's `finally` releases the session it owns, and
    // reopening one here only to throw it away would add a second or two to
    // every run for nothing.
    if (recycleRuntime && size !== sizes[sizes.length - 1]) {
      const reopened = await recycleRuntime();
      if (!reopened) {
        failures.push({
          size,
          // Not the size's own failure — it succeeded. This records why the
          // sizes after it were never attempted, so a short report is not read
          // as a clean sweep.
          error: 'Could not reopen the model after this size; remaining sizes were not run.',
        });
        break;
      }
      runtime = reopened;
    }
  }

  return {
    modelVersion: input.modelVersion,
    modelConfig: input.modelConfig,
    requestedExecutionProvider: input.requestedExecutionProvider,
    defaultThreshold,
    lowThreshold,
    preprocessing: { fit, mean: [...mean], std: [...std] },
    photo: {
      width: image.width,
      height: image.height,
      sourceWidth: image.sourceWidth,
      sourceHeight: image.sourceHeight,
    },
    sizes: results,
    failures,
  };
}

/** The "copy results" payload: everything a decision needs, and the device it came from. */
export function formatBenchmarkJson(report: BenchmarkReport, device: Record<string, unknown>): string {
  return JSON.stringify({ issue: 5435, decides: 5451, device, ...report }, null, 2);
}
