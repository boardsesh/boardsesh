import { appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { discoverNextStaticAssets, publishNextStaticAssets, type NextStaticAsset } from './lib/next-static-assets';
import {
  assertRemoteStaticAssetMetadata,
  createRequestStartLimiter,
  readResponseBodyWithinLimit,
  type RequestStartLimiter,
} from './lib/static-asset-upload';
import { readNextStaticAssetEnvironment } from './upload-next-static-assets';

export const BENCHMARK_RATES = [5, 10, 20, 20, 10, 5] as const;
const MAX_BENCHMARK_ASSETS = 400;
const REQUEST_TIMEOUT_MS = 30_000;
type RequestCounts = Record<string, number>;
export type BenchmarkRound = {
  rate: number;
  seconds: number;
  requests: RequestCounts;
  cacheStatuses: RequestCounts;
  uploaded?: number;
  existing?: number;
};
export type BenchmarkReport = {
  imageDigest: string;
  startedAt: string;
  status: 'running' | 'passed' | 'failed';
  phase: 'preflight' | 'publishing' | 'complete';
  assets: number;
  bytes: number;
  workers: number;
  rounds: BenchmarkRound[];
  failure?: string;
};

export function serializedRequestLimiter(rate: number): RequestStartLimiter {
  const limit = createRequestStartLimiter(rate);
  let previous = Promise.resolve();
  return () => {
    const next = previous.then(limit);
    previous = next.catch(() => {});
    return next;
  };
}

function responseStatus(response: unknown): number {
  if (response && typeof response === 'object' && '$metadata' in response) {
    const metadata = response.$metadata as { httpStatusCode?: unknown } | undefined;
    if (typeof metadata?.httpStatusCode === 'number') return metadata.httpStatusCode;
  }
  return 0;
}

/** Verify the entire image's asset set before the first conditional PUT. */
export async function verifyExistingAssets(
  assets: readonly NextStaticAsset[],
  bucket: string,
  client: S3Client,
  beforeRequest: RequestStartLimiter,
): Promise<void> {
  for (const asset of assets) {
    await beforeRequest();
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: asset.objectKey, ChecksumMode: 'ENABLED' }),
      { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    await beforeRequest();
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const stored = await client.send(new GetObjectCommand({ Bucket: bucket, Key: asset.objectKey }), {
      abortSignal: signal,
    });
    if (!stored.Body) throw new Error('Existing asset body is missing');
    const contents = await readResponseBodyWithinLimit(
      new Response(stored.Body.transformToWebStream()),
      asset.bytes,
      signal,
    );
    for (const metadata of [head, stored]) {
      assertRemoteStaticAssetMetadata(
        asset,
        {
          bytes: metadata.ContentLength,
          contentType: metadata.ContentType,
          cacheControl: metadata.CacheControl,
          checksumSha256: metadata.ChecksumSHA256,
        },
        contents,
      );
    }
  }
}

type BenchmarkOptions = {
  directory: string;
  bucket: string;
  client: S3Client;
  imageDigest: string;
  fetchImpl?: typeof fetch;
  createLimiter?: (rate: number) => RequestStartLimiter;
  onProgress?: (report: BenchmarkReport) => Promise<void>;
};

export async function benchmarkNextStaticAssets(options: BenchmarkOptions): Promise<BenchmarkReport> {
  if (!/^sha256:[0-9a-f]{64}$/.test(options.imageDigest)) throw new Error('An immutable image digest is required');
  const createLimiter = options.createLimiter ?? serializedRequestLimiter;
  const report: BenchmarkReport = {
    imageDigest: options.imageDigest,
    startedAt: new Date().toISOString(),
    status: 'running',
    phase: 'preflight',
    assets: 0,
    bytes: 0,
    workers: 4,
    rounds: [],
  };
  let currentRound: BenchmarkRound | undefined;
  function count(operation: string, status: number): void {
    if (!currentRound) return;
    const key = `${operation}:${status}`;
    currentRound.requests[key] = (currentRound.requests[key] ?? 0) + 1;
  }
  // SDK retries are disabled by the CLI. Count responses even if the unchanged
  // publisher retries successfully, so throttling cannot look like a clean run.
  const middlewareName = 'nextStaticAssetBenchmark';
  options.client.middlewareStack.add(
    (next, context) => async (arguments_) => {
      try {
        const result = await next(arguments_);
        count(context.commandName ?? 'UnknownCommand', responseStatus(result.output));
        return result;
      } catch (error) {
        count(context.commandName ?? 'UnknownCommand', responseStatus(error));
        throw error;
      }
    },
    { step: 'initialize', name: middlewareName, priority: 'high' },
  );
  const fetchImpl: typeof fetch = async (input, init) => {
    try {
      const response = await (options.fetchImpl ?? fetch)(input, init);
      count('CDN_GET', response.status);
      if (currentRound) {
        const cacheStatus = response.headers.get('cf-cache-status') ?? 'missing';
        currentRound.cacheStatuses[cacheStatus] = (currentRound.cacheStatuses[cacheStatus] ?? 0) + 1;
      }
      return response;
    } catch (error) {
      count('CDN_GET', 0);
      throw error;
    }
  };
  try {
    await options.onProgress?.(report);
    const assets = await discoverNextStaticAssets(options.directory);
    if (assets.length > MAX_BENCHMARK_ASSETS) throw new Error('Asset set exceeds the bounded benchmark size');
    report.assets = assets.length;
    report.bytes = assets.reduce((total, asset) => total + asset.bytes, 0);
    await options.onProgress?.(report);
    await verifyExistingAssets(assets, options.bucket, options.client, createLimiter(5));
    report.phase = 'publishing';
    for (const rate of BENCHMARK_RATES) {
      currentRound = { rate, seconds: 0, requests: {}, cacheStatuses: {} };
      report.rounds.push(currentRound);
      await options.onProgress?.(report);
      const started = performance.now();
      try {
        const result = await publishNextStaticAssets({
          directory: options.directory,
          bucket: options.bucket,
          client: options.client,
          concurrency: report.workers,
          beforeRequest: createLimiter(rate),
          fetchImpl,
        });
        currentRound.uploaded = result.uploaded;
        currentRound.existing = result.existing;
        const expected: RequestCounts = {
          'PutObjectCommand:412': assets.length,
          'HeadObjectCommand:200': assets.length,
          'GetObjectCommand:200': assets.length,
          'CDN_GET:200': assets.length * 2,
        };
        if (
          result.uploaded !== 0 ||
          result.existing !== assets.length ||
          Object.keys(currentRound.requests).length !== Object.keys(expected).length ||
          Object.entries(expected).some(([operation, total]) => currentRound?.requests[operation] !== total)
        ) {
          throw new Error('Unexpected request, retry, or new upload; stopping before the next rate');
        }
      } finally {
        currentRound.seconds = (performance.now() - started) / 1000;
        await options.onProgress?.(report);
      }
    }
    report.status = 'passed';
    report.phase = 'complete';
  } catch (error) {
    report.status = 'failed';
    // SDK errors can contain signed request details. Persist only the error class.
    report.failure = error instanceof Error ? error.name : 'UnknownError';
  } finally {
    options.client.middlewareStack.remove(middlewareName);
    await options.onProgress?.(report);
  }
  return report;
}

export function parseBenchmarkArguments(arguments_: readonly string[]): { directory: string; output: string } {
  if (
    arguments_.length !== 4 ||
    arguments_[0] !== '--directory' ||
    arguments_[2] !== '--output' ||
    !arguments_[1]?.trim() ||
    !arguments_[3]?.trim() ||
    arguments_[1].startsWith('--') ||
    arguments_[3].startsWith('--')
  ) {
    throw new Error('Usage: --directory <extracted .next/static directory> --output <report.json>');
  }
  return { directory: arguments_[1], output: arguments_[3] };
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { directory, output } = parseBenchmarkArguments(arguments_);
  const { bucket, ...configuration } = readNextStaticAssetEnvironment();
  const client = new S3Client({ ...configuration, maxAttempts: 1 });
  try {
    const report = await benchmarkNextStaticAssets({
      directory,
      bucket,
      client,
      imageDigest: process.env.BENCHMARK_IMAGE_DIGEST ?? '',
      onProgress: async (progress) => {
        await writeFile(output, `${JSON.stringify(progress, null, 2)}\n`);
      },
    });
    console.log(JSON.stringify(report, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        [
          `## Existing Next asset benchmark: ${report.status}`,
          `${report.assets} assets; ${report.workers} workers; image \`${report.imageDigest}\`.`,
          '',
          '| Round | Requests/second limit | Seconds | Uploaded |',
          '| --- | --- | --- | --- |',
          ...report.rounds.map(
            (round, index) =>
              `| ${index + 1} | ${round.rate} | ${round.seconds.toFixed(2)} | ${round.uploaded ?? 'failed'} |`,
          ),
          '',
          'Includes conditional PUT, signed HEAD/GET, and both CDN GET shapes. Does not measure first-upload propagation.',
          '',
        ].join('\n'),
      );
    }
    if (report.status !== 'passed') process.exitCode = 1;
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    console.error('Next static asset benchmark failed; inspect the sanitized report.');
    process.exitCode = 1;
  });
}
