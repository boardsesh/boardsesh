import { describe, expect, it } from 'vitest';

import type { DetectionRuntime, RfDetrOutputs } from '@boardsesh/hold-detection';
import { formatBenchmarkJson, median, runBenchmark } from '../benchmark';

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
      executionProvider: 'xnnpack',
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
      executionProvider: 'cpu',
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
      executionProvider: 'cpu',
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
      executionProvider: 'cpu',
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
      executionProvider: 'cpu',
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
});

describe('formatBenchmarkJson', () => {
  it('carries the device and the issue numbers a reader needs', async () => {
    const report = await runBenchmark({
      runtime: fakeRuntime([0.9]),
      image: greyPhoto(64, 48),
      modelVersion: '2026-09-15',
      modelConfig: 'nano-untiled-1024',
      executionProvider: 'coreml',
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
      executionProvider: 'coreml',
    });
  });
});
