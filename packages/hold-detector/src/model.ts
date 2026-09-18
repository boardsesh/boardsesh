/**
 * Fetching, verifying and holding the model.
 *
 * Weights are immutable per version, so they are cached by version on disk and
 * a cache hit is still verified — a corrupted or tampered cache file would
 * otherwise silently become the model this service runs.
 *
 * The session is loaded once and kept for the container's life. On a service
 * that sleeps when idle (Railway Serverless) the load is paid on the cold boot
 * that follows a wake, not per request.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { InferenceSession } from 'onnxruntime-node';

import { type Manifest, assertSupported, pickWeights, verifyWeights } from './manifest';

export interface LoadedModel {
  session: InferenceSession;
  manifest: Manifest;
  weightsSha256: string;
}

export interface LoadModelOptions {
  /** Base URL of the published models, e.g. https://media.boardsesh.com/models/hold-detector */
  baseUrl: string;
  version: string;
  /** Where verified weights are kept between boots. */
  cacheDir: string;
  /** Threads for the ONNX session; defaults to letting onnxruntime decide. */
  threads?: number;
  fetchImpl?: typeof fetch;
}

async function fetchBuffer(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function loadModel(options: LoadModelOptions): Promise<LoadedModel> {
  const { baseUrl, version, cacheDir, threads, fetchImpl = fetch } = options;
  const base = `${baseUrl.replace(/\/$/, '')}/${version}`;

  const manifest = JSON.parse((await fetchBuffer(`${base}/manifest.json`, fetchImpl)).toString('utf8')) as Manifest;
  assertSupported(manifest);

  const wanted = pickWeights(manifest);
  const cachePath = join(cacheDir, version, wanted.path);

  let bytes: Buffer | null = null;
  try {
    bytes = await readFile(cachePath);
    // A cache hit is verified too: the point of the digest is that nothing runs
    // unverified, and "it was already on disk" is not evidence.
    verifyWeights(bytes, wanted);
  } catch {
    bytes = null;
  }

  if (!bytes) {
    bytes = await fetchBuffer(`${base}/${wanted.path}`, fetchImpl);
    verifyWeights(bytes, wanted);
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, bytes);
  }

  const session = await InferenceSession.create(bytes, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    ...(threads ? { intraOpNumThreads: threads, interOpNumThreads: 1 } : {}),
  });

  return { session, manifest, weightsSha256: wanted.sha256 };
}
