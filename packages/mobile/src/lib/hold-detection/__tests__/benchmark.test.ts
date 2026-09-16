import { describe, expect, it } from 'vitest';

import type { DetectionRuntime, RfDetrOutputs } from '@boardsesh/hold-detection';
import { BENCHMARK_INPUT_SIZES, formatBenchmarkJson, lowThresholdFor, median, runBenchmark } from '../benchmark';

/** A grey photo — the pixels never matter, the fake runtime ignores them. */
function greyPhoto(width: number, height: number) {
  return {
    width,
    height,
    rgba: new Uint8ClampedArray(width * height * 4).fill(128),
    sourceWidth: width * 2,
    sourceHeight: height * 2,
  };
}

/**
 * A runtime that returns `scores.length` queries with the given sigmoid scores,
 * one box each, and records the tensor sizes it was asked for.
 */
function fakeRuntime(scores: number[]): DetectionRuntime & { sizes: number[] } {
  const sizes: number[] = [];
  const boxes = new Float32Array(scores.length * 4);
  const logits = new Float32Array(scores.length);
  for (let index = 0; index < scores.length; index += 1) {
    // Spread the boxes apart: identical boxes would be merged by NMS and a
    // three-query fixture would arrive as one candidate.
    boxes.set([0.15 + index * 0.3, 0.5, 0.08, 0.08], index * 4);
    // decodeRfDetr applies sigmoid, so store the logit that produces the score.
    logits[index] = Math.log(scores[index] / (1 - scores[index]));
  }
  return {
    sizes,
    run(_input: Float32Array, size: number): RfDetrOutputs {
      sizes.push(size);
      return { boxes, boxesShape: [1, scores.length, 4], logits, logitsShape: [1, scores.length, 1] };
    },
  };
}

describe('median', () => {
  it.each([
    [[5], 5],
    [[3, 1, 2], 2],
    [[4, 1, 3, 2], 2.5],
  ])('of %j is %d', (values, expected) => {
    expect(median(values)).toBe(expected);
  });

  it('is 0 for an empty sample rather than NaN', () => {
    expect(median([])).toBe(0);
  });
});

describe('runBenchmark', () => {
  it('runs every size the requested number of times', async () => {
    const runtime = fakeRuntime([0.9]);

    const report = await runBenchmark({
      runtime,
      image: greyPhoto(64, 48),
      modelVersion: '2026-09-15',
      modelConfig: 'nano-untiled-1024',
      requestedExecutionProvider: 'xnnpack',
      defaultThreshold: 0.6,
      fit: 'stretch',
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      sizes: [768, 512],
      runsPerSize: 3,
    });

    expect(runtime.sizes).toEqual([768, 768, 768, 512, 512, 512]);
    expect(report.sizes.map((size) => size.size)).toEqual([768, 512]);
    expect(report.sizes.every((size) => size.runsMs.length === 3)).toBe(true);
  });

  it('counts detections at both thresholds from one pass', async () => {
    // Three queries either side of the 0.6 default and above the 0.3 floor.
    const runtime = fakeRuntime([0.95, 0.65, 0.4]);

    const report = await runBenchmark({
      runtime,
      image: greyPhoto(64, 48),
      modelVersion: 'v',
      modelConfig: 'c',
      requestedExecutionProvider: 'cpu',
      defaultThreshold: 0.6,
      fit: 'stretch',
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      sizes: [512],
      runsPerSize: 1,
    });

    expect(report.sizes[0].detectionsAtLow).toBe(3);
    expect(report.sizes[0].detectionsAtDefault).toBe(2);
  });

  it('reports the median of its passes, not the last one', async () => {
    let tick = 0;
    // 10 ms, 50 ms, 30 ms -> p50 30, which no single pass would have reported.
    const durations = [10, 50, 30];
    const now = () => {
      const at = tick;
      tick += 1;
      return at % 2 === 0 ? 0 : durations[(at - 1) / 2];
    };

    const report = await runBenchmark({
      runtime: fakeRuntime([0.9]),
      image: greyPhoto(64, 48),
      modelVersion: 'v',
      modelConfig: 'c',
      requestedExecutionProvider: 'cpu',
      defaultThreshold: 0.6,
      fit: 'stretch',
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      sizes: [512],
      runsPerSize: 3,
      now,
    });

    expect(report.sizes[0].runsMs).toEqual([10, 50, 30]);
    expect(report.sizes[0].p50Ms).toBe(30);
  });

  it('puts the frame through the preprocessing it was given and records it', async () => {
    // A white photo with mean 0 / std 1 is 1.0 everywhere; under the shared
    // package's ImageNet default the same pixels arrive near 2.2. Asserting the
    // TENSOR, not just the echoed report, is what catches the options being
    // dropped between here and `runDetection`.
    const seen: Float32Array[] = [];
    const runtime = {
      run(input: Float32Array) {
        seen.push(Float32Array.from(input));
        return {
          boxes: new Float32Array(0),
          boxesShape: [1, 0, 4],
          logits: new Float32Array(0),
          logitsShape: [1, 0, 1],
        };
      },
    };
    const white = {
      width: 4,
      height: 4,
      rgba: new Uint8ClampedArray(4 * 4 * 4).fill(255),
      sourceWidth: 8,
      sourceHeight: 8,
    };

    const report = await runBenchmark({
      runtime,
      image: white,
      modelVersion: 'v',
      modelConfig: 'c',
      requestedExecutionProvider: 'cpu',
      defaultThreshold: 0.6,
      fit: 'contain',
      mean: [0, 0, 0],
      std: [1, 1, 1],
      sizes: [2],
      runsPerSize: 1,
    });

    expect(Array.from(seen[0])).toEqual(new Array(3 * 2 * 2).fill(1));
    expect(report.preprocessing).toEqual({ fit: 'contain', mean: [0, 0, 0], std: [1, 1, 1] });
  });

  it('reports the progress of every pass so the screen can say what is slow', async () => {
    const seen: string[] = [];

    await runBenchmark({
      runtime: fakeRuntime([0.9]),
      image: greyPhoto(64, 48),
      modelVersion: 'v',
      modelConfig: 'c',
      requestedExecutionProvider: 'cpu',
      defaultThreshold: 0.6,
      fit: 'stretch',
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      sizes: [640],
      runsPerSize: 2,
      onProgress: (size, run, totalRuns) => seen.push(`${size}:${run}/${totalRuns}`),
    });

    expect(seen).toEqual(['640:1/2', '640:2/2']);
  });

  it('keeps the sizes that ran when one size is refused by the runtime', async () => {
    // The shipped graph is exported at a fixed 768 with no dynamic axes, so ONNX
    // Runtime rejects 640 — and the 768 numbers the decision rests on must not go
    // down with it.
    const seen: number[] = [];
    const good = fakeRuntime([0.9, 0.4]);
    const runtime = {
      run(input: Float32Array, size: number): RfDetrOutputs | Promise<RfDetrOutputs> {
        seen.push(size);
        if (size === 640) throw new Error('Got invalid dimensions for input: input for the following indices');
        return good.run(input, size);
      },
    };

    const report = await runBenchmark({
      runtime,
      image: greyPhoto(64, 48),
      modelVersion: 'v',
      modelConfig: 'c',
      requestedExecutionProvider: 'cpu',
      defaultThreshold: 0.6,
      fit: 'stretch',
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      sizes: [768, 640, 512],
      runsPerSize: 2,
    });

    expect(report.sizes.map((size) => size.size)).toEqual([768, 512]);
    expect(report.failures).toEqual([
      { size: 640, error: 'Got invalid dimensions for input: input for the following indices' },
    ]);
    // It stopped that size on the first throw rather than burning two more passes.
    expect(seen).toEqual([768, 768, 640, 512, 512]);
  });

  it('reports every size as a failure when the runtime refuses all of them', async () => {
    const report = await runBenchmark({
      runtime: {
        run(): RfDetrOutputs {
          throw new Error('no kernel');
        },
      },
      image: greyPhoto(64, 48),
      modelVersion: 'v',
      modelConfig: 'c',
      requestedExecutionProvider: 'cpu',
      defaultThreshold: 0.6,
      fit: 'stretch',
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      sizes: [768, 512],
      runsPerSize: 1,
    });

    expect(report.sizes).toEqual([]);
    expect(report.failures.map((failure) => failure.size)).toEqual([768, 512]);
  });

  it('decodes at the manifest default when it is below the 0.3 floor', async () => {
    // A manifest shipping 0.1 used to make both columns the same number, because
    // the low pass was pinned at 0.3 and the "default" count filtered a set that
    // had already been cut at 0.3.
    const runtime = fakeRuntime([0.9, 0.2, 0.15]);

    const report = await runBenchmark({
      runtime,
      image: greyPhoto(64, 48),
      modelVersion: 'v',
      modelConfig: 'c',
      requestedExecutionProvider: 'cpu',
      defaultThreshold: 0.1,
      fit: 'stretch',
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      sizes: [512],
      runsPerSize: 1,
    });

    expect(report.lowThreshold).toBe(0.1);
    expect(report.sizes[0].detectionsAtLow).toBe(3);
    expect(report.sizes[0].detectionsAtDefault).toBe(3);
  });

  it('keeps the 0.3 floor when the manifest default is above it', async () => {
    const report = await runBenchmark({
      runtime: fakeRuntime([0.9]),
      image: greyPhoto(64, 48),
      modelVersion: 'v',
      modelConfig: 'c',
      requestedExecutionProvider: 'cpu',
      defaultThreshold: 0.6,
      fit: 'stretch',
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      sizes: [512],
      runsPerSize: 1,
    });

    expect(report.lowThreshold).toBe(0.3);
  });
});

describe('lowThresholdFor', () => {
  it.each([
    [0.6, 0.3],
    [0.3, 0.3],
    [0.1, 0.1],
  ])('takes the smaller of 0.3 and a %d default', (defaultThreshold, expected) => {
    expect(lowThresholdFor(defaultThreshold)).toBe(expected);
  });
});

describe('formatBenchmarkJson', () => {
  it('carries the device and the issue numbers a reader needs', async () => {
    const report = await runBenchmark({
      runtime: fakeRuntime([0.9]),
      image: greyPhoto(64, 48),
      modelVersion: '2026-09-15',
      modelConfig: 'nano-untiled-1024',
      requestedExecutionProvider: 'coreml',
      defaultThreshold: 0.6,
      fit: 'stretch',
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225],
      sizes: [512],
      runsPerSize: 1,
    });

    const parsed = JSON.parse(formatBenchmarkJson(report, { platform: 'ios', modelName: 'iPhone 14' })) as Record<
      string,
      unknown
    >;

    expect(parsed).toMatchObject({
      issue: 5435,
      decides: 5451,
      device: { platform: 'ios', modelName: 'iPhone 14' },
      modelVersion: '2026-09-15',
      requestedExecutionProvider: 'coreml',
    });
  });
});

describe('sweep order', () => {
  it('runs the cheapest size first so a kill during the largest still leaves numbers', () => {
    // Load-bearing, not cosmetic: 768 is the size SW-01 measured at 987 MB
    // against a 500 MB phone budget, so it is the one that gets the process
    // killed — and a watchdog kill takes the whole report with it. Ascending
    // order means 512 and 640 are already in hand by then.
    expect([...BENCHMARK_INPUT_SIZES]).toEqual([512, 640, 768]);
    expect(Math.max(...BENCHMARK_INPUT_SIZES)).toBe(BENCHMARK_INPUT_SIZES[BENCHMARK_INPUT_SIZES.length - 1]);
  });
});

describe('runBenchmark runtime recycling', () => {
  const baseInput = {
    image: greyPhoto(64, 48),
    modelVersion: '2026-09-15',
    modelConfig: 'nano-untiled-1024',
    requestedExecutionProvider: 'coreml',
    defaultThreshold: 0.6,
    fit: 'stretch' as const,
    mean: [0.485, 0.456, 0.406] as readonly [number, number, number],
    std: [0.229, 0.224, 0.225] as readonly [number, number, number],
    runsPerSize: 1,
  };

  it('recycles between sizes but not after the last one', async () => {
    let recycles = 0;
    const report = await runBenchmark({
      ...baseInput,
      runtime: fakeRuntime([0.9]),
      sizes: [512, 640, 768],
      recycleRuntime: async () => {
        recycles += 1;
        return fakeRuntime([0.9]);
      },
    });

    // Three sizes, two gaps between them. A third call would open a session
    // the caller's `finally` immediately releases.
    expect(recycles).toBe(2);
    expect(report.sizes.map((size) => size.size)).toEqual([512, 640, 768]);
  });

  it('routes each size to the runtime that was live for it', async () => {
    const first = fakeRuntime([0.9]);
    const second = fakeRuntime([0.9]);
    await runBenchmark({
      ...baseInput,
      runtime: first,
      sizes: [512, 640],
      recycleRuntime: async () => second,
    });

    // Without the reassignment in runBenchmark the original runtime would have
    // served both sizes and the recycled session would sit idle.
    expect(first.sizes).toEqual([512]);
    expect(second.sizes).toEqual([640]);
  });

  it('keeps the sizes already measured when the model will not reopen', async () => {
    const report = await runBenchmark({
      ...baseInput,
      runtime: fakeRuntime([0.9]),
      sizes: [512, 640, 768],
      recycleRuntime: async () => null,
    });

    // The point of the whole change: a device that cannot carry on still hands
    // back the number it did get, rather than an empty report.
    expect(report.sizes.map((size) => size.size)).toEqual([512]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].error).toContain('remaining sizes were not run');
  });

  it('works without a recycler, so a single-session caller is unaffected', async () => {
    const runtime = fakeRuntime([0.9]);
    const report = await runBenchmark({ ...baseInput, runtime, sizes: [512, 640] });

    expect(runtime.sizes).toEqual([512, 640]);
    expect(report.sizes).toHaveLength(2);
  });
});
