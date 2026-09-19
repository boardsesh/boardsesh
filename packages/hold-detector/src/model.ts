/**
 * Fetching, verifying and holding the model.
 *
 * Weights are immutable per version, so they are cached by version on disk and
 * a cache hit is still verified — a corrupted or tampered cache file would
 * otherwise silently become the model this service runs.
 *
 * The dedicated homelab worker keeps one warm session. A replacement inference
 * thread reloads it after a timeout or native-runtime failure.
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
  /** Pin the artifact before creating a native session, not after loading it. */
  weightsSha256?: string;
  fetchImpl?: typeof fetch;
}

async function fetchBuffer(url: string, fetchImpl: typeof fetch, limit = 200 * 1024 * 1024): Promise<Buffer> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  if (!response.body) throw new Error('EMPTY_MODEL_ARTIFACT');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error('MODEL_ARTIFACT_TOO_LARGE');
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}

export async function loadModel(options: LoadModelOptions): Promise<LoadedModel> {
  const { baseUrl, version, cacheDir, threads, fetchImpl = fetch } = options;
  if (!/^[A-Za-z0-9_-]+$/.test(version)) throw new Error('Invalid model version');
  const base = `${baseUrl.replace(/\/$/, '')}/${version}`;

  const manifest = JSON.parse(
    (await fetchBuffer(`${base}/manifest.json`, fetchImpl, 64 * 1024)).toString('utf8'),
  ) as Manifest;
  assertSupported(manifest);
  if (manifest.version !== version) throw new Error('Model manifest version mismatch');

  const wanted = pickWeights(manifest);
  if (options.weightsSha256 && wanted.sha256 !== options.weightsSha256) throw new Error('MODEL_IDENTITY_MISMATCH');
  if (!/^[A-Za-z0-9_-]+\.onnx$/.test(wanted.path)) throw new Error('Invalid model artifact path');
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
