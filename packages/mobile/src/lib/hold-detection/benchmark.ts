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
 * manifest's own default threshold and at 0.3, and what the JS heap did. It is
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
 */
export const BENCHMARK_INPUT_SIZES = [768, 640, 512] as const;

/** Second threshold every size is also counted at, for the confidence slider (#5441). */
export const BENCHMARK_LOW_THRESHOLD = 0.3;

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
  /** Candidates at `BENCHMARK_LOW_THRESHOLD`. */
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

export interface BenchmarkReport {
  modelVersion: string;
  modelConfig: string;
  executionProvider: string;
  defaultThreshold: number;
  photo: { width: number; height: number; sourceWidth: number; sourceHeight: number };
  sizes: BenchmarkSizeResult[];
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
  executionProvider: string;
  defaultThreshold: number;
  sizes?: readonly number[];
  runsPerSize?: number;
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
 * pass at 0.3 would be the same tensors filtered differently. The timed passes
 * use the manifest default, so a latency number is never the cheaper of the two.
 */
export async function runBenchmark(input: BenchmarkInput): Promise<BenchmarkReport> {
  const {
    runtime,
    image,
    sizes = BENCHMARK_INPUT_SIZES,
    runsPerSize = BENCHMARK_RUNS_PER_SIZE,
    defaultThreshold,
    onProgress,
    now = Date.now,
  } = input;

  const results: BenchmarkSizeResult[] = [];
  for (const size of sizes) {
    const heapBefore = readJsHeapBytes();
    const runsMs: number[] = [];
    let lastCandidates: HoldCandidate[] = [];
    for (let run = 0; run < runsPerSize; run += 1) {
      onProgress?.(size, run + 1, runsPerSize);
      const startedAt = now();
      const { candidates } = await runDetection(runtime, image, { size, scoreThreshold: BENCHMARK_LOW_THRESHOLD });
      runsMs.push(now() - startedAt);
      lastCandidates = candidates;
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
  }

  return {
    modelVersion: input.modelVersion,
    modelConfig: input.modelConfig,
    executionProvider: input.executionProvider,
    defaultThreshold,
    photo: {
      width: image.width,
      height: image.height,
      sourceWidth: image.sourceWidth,
      sourceHeight: image.sourceHeight,
    },
    sizes: results,
  };
}

/** The "copy results" payload: everything a decision needs, and the device it came from. */
export function formatBenchmarkJson(report: BenchmarkReport, device: Record<string, unknown>): string {
  return JSON.stringify({ issue: 5435, decides: 5451, device, ...report }, null, 2);
}
