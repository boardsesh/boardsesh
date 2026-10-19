/// <reference types="node" />

/** An observed control restoration, issued only by the trusted main unlock job. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  object,
  string,
  UUID,
  UPDATE_ID,
  parseServedManifest,
  requestManifest,
  requireSuccess,
} from './ota-publish-protocol.ts';
import type { OtaPlatform } from './ota-publish-protocol.ts';
import { createStableGithubClient, githubId, parseTrustedArtifact } from './ota-stable-github.ts';

export interface UnlockProof {
  repository: string;
  requestId: string;
  runId: number;
  headSha: string;
}
export interface UnlockExpectations {
  appId: string;
  runtimes: Record<OtaPlatform, string>;
  baselines: Record<OtaPlatform, string | null>;
}
export interface UnlockPlatformReceipt {
  runtimeVersion: string;
  originalUpdateId: string | null;
  restoredUpdateId: string | null;
  contentSha256: string | null;
  mode: 'unchanged' | 'reverted';
}
export interface UnlockReceipt extends UnlockProof {
  version: 1;
  runAttempt: 1;
  branch: 'production';
  appId: string;
  platforms: Record<OtaPlatform, UnlockPlatformReceipt>;
}
const FINGERPRINT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RECEIPT_BYTES = 65_536;

export function unlockArtifactName(requestId: string): string {
  if (!REQUEST_ID.test(requestId)) throw new Error('Invalid unlock receipt request id.');
  return `ota-unlock-${requestId}`;
}
export function validateUnlockExpectations(expected: UnlockExpectations): void {
  if (!UUID.test(expected.appId)) throw new Error('Invalid staged unlock app ID.');
  for (const platform of ['ios', 'android'] as const) {
    if (!FINGERPRINT.test(expected.runtimes[platform])) throw new Error(`Invalid ${platform} unlock runtime.`);
    const baseline = expected.baselines[platform];
    if (baseline !== null && !UPDATE_ID.test(baseline)) throw new Error(`Invalid ${platform} unlock baseline.`);
  }
}
export function validateUnlockProof(proof: UnlockProof): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(proof.repository)) throw new Error('Invalid unlock repository.');
  githubId(proof.runId, 'Unlock run ID');
  unlockArtifactName(proof.requestId);
  if (!FINGERPRINT.test(proof.headSha)) throw new Error('Invalid unlock head SHA.');
}

/** Also rechecked by the publisher; neither caller may reinterpret a no-op as a replacement. */
export function validateUnlockReceipt(input: unknown, proof: UnlockProof, expected: UnlockExpectations): UnlockReceipt {
  validateUnlockProof(proof);
  validateUnlockExpectations(expected);
  const receipt = object(input, 'Unlock receipt');
  if (
    receipt.version !== 1 ||
    receipt.runAttempt !== 1 ||
    receipt.branch !== 'production' ||
    receipt.repository !== proof.repository ||
    receipt.requestId !== proof.requestId ||
    receipt.runId !== proof.runId ||
    receipt.headSha !== proof.headSha ||
    receipt.appId !== expected.appId
  )
    throw new Error('Unlock receipt does not match the trusted main run and staged app.');
  const platforms = object(receipt.platforms, 'Unlock platforms');
  const parsed = {} as Record<OtaPlatform, UnlockPlatformReceipt>;
  for (const platform of ['ios', 'android'] as const) {
    const entry = object(platforms[platform], `${platform} unlock receipt`);
    if (entry.runtimeVersion !== expected.runtimes[platform] || entry.originalUpdateId !== expected.baselines[platform])
      throw new Error(`${platform} unlock receipt does not match the staged runtime and baseline.`);
    const restored = entry.restoredUpdateId;
    const digest = entry.contentSha256;
    if (restored !== null && (typeof restored !== 'string' || !UPDATE_ID.test(restored)))
      throw new Error(`${platform} restored update ID is invalid.`);
    if (digest !== null && (typeof digest !== 'string' || !SHA256.test(digest)))
      throw new Error(`${platform} control content digest is invalid.`);
    if ((restored === null) !== (digest === null)) throw new Error(`${platform} control content is missing.`);
    if (entry.mode === 'unchanged') {
      if (restored !== entry.originalUpdateId) throw new Error(`${platform} no-op cannot authorize a changed update.`);
    } else if (
      entry.mode !== 'reverted' ||
      entry.originalUpdateId === null ||
      restored === null ||
      restored === entry.originalUpdateId
    ) {
      throw new Error(`${platform} unlock receipt has no valid restoration.`);
    }
    parsed[platform] = {
      runtimeVersion: expected.runtimes[platform],
      originalUpdateId: expected.baselines[platform],
      restoredUpdateId: restored as string | null,
      contentSha256: digest as string | null,
      mode: entry.mode,
    };
  }
  return { ...proof, version: 1, runAttempt: 1, branch: 'production', appId: expected.appId, platforms: parsed };
}

function canonicalJson(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonicalJson);
  if (input !== null && typeof input === 'object')
    return Object.fromEntries(
      Object.entries(input)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, content]) => [key, canonicalJson(content)]),
    );
  return input;
}
export interface ControlHead {
  updateId: string | null;
  contentSha256: string | null;
}
export async function readControlHead(options: {
  manifestUrl: string;
  appId: string;
  runtimeVersion: string;
  platform: OtaPlatform;
  fetchImpl?: typeof fetch;
}): Promise<ControlHead> {
  const response = await requestManifest({ ...options, branch: 'production', fetchImpl: options.fetchImpl ?? fetch });
  await requireSuccess(response, `${options.platform} control manifest`);
  const manifest = parseServedManifest(await response.text(), 'production');
  if (manifest === null) return { updateId: null, contentSha256: null };
  const updateId = string(manifest.id, 'Control update ID');
  const extra = object(manifest.extra, 'Control manifest extra');
  const expoClient = object(extra.expoClient, 'Control Expo config');
  const headers = object(object(expoClient.updates, 'Control updates config').requestHeaders, 'Control headers');
  if (
    !UPDATE_ID.test(updateId) ||
    manifest.runtimeVersion !== options.runtimeVersion ||
    extra.branch !== 'production' ||
    headers['expo-app-id'] !== options.appId ||
    headers['expo-channel-name'] !== 'production'
  )
    throw new Error(`${options.platform} control manifest has a different identity.`);
  const bundleHash = string(object(manifest.launchAsset, 'Control launch asset').hash, 'Control bundle hash');
  if (!Array.isArray(manifest.assets)) throw new Error('Control manifest has no assets.');
  const assetHashes = manifest.assets
    .map((asset: unknown) => string(object(asset, 'Control asset').hash, 'Control asset hash'))
    .sort();
  const contentSha256 = createHash('sha256')
    .update(JSON.stringify(canonicalJson({ bundleHash, assetHashes, expoClient })))
    .digest('hex');
  return { updateId, contentSha256 };
}

// Read one bounded JSON member without extracting paths or running artifact code.
export function readUnlockReceiptZip(bytes: Uint8Array): unknown {
  if (bytes.length < 1 || bytes.length > MAX_RECEIPT_BYTES) throw new Error('Unlock receipt ZIP is oversized.');
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import io, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    entries = archive.infolist()
    if len(entries) != 1 or entries[0].filename != 'receipt.json' or entries[0].file_size > 65536:
        raise ValueError('Unlock artifact must contain exactly one bounded receipt.json')
    sys.stdout.buffer.write(archive.read(entries[0]))
`,
    ],
    { input: bytes, maxBuffer: MAX_RECEIPT_BYTES, timeout: 10_000 },
  );
  if (result.status !== 0) throw new Error('Unlock receipt ZIP is invalid.');
  return JSON.parse(result.stdout.toString('utf8')) as unknown;
}

/** Called only after the existing waiter validated the exact workflow, job and attempt. */
export async function downloadUnlockReceipt(
  options: UnlockExpectations & {
    proof: UnlockProof;
    token: string;
    fetchImpl?: typeof fetch;
    nowMs?: () => number;
  },
): Promise<UnlockReceipt> {
  validateUnlockProof(options.proof);
  validateUnlockExpectations(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = `https://api.github.com/repos/${options.proof.repository}`;
  const response = await fetchImpl(`${apiBase}/actions/runs/${options.proof.runId}/artifacts?per_page=100`, {
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Could not read trusted unlock artifacts.');
  const listing = object((await response.json()) as unknown, 'Unlock artifact listing');
  if (
    !Array.isArray(listing.artifacts) ||
    listing.artifacts.length > 100 ||
    listing.total_count !== listing.artifacts.length
  )
    throw new Error('Ambiguous unlock artifact listing.');
  const name = unlockArtifactName(options.proof.requestId);
  const matches = listing.artifacts.filter((entry: unknown) => object(entry, 'Unlock artifact').name === name);
  if (matches.length !== 1) throw new Error('Expected exactly one trusted unlock receipt artifact.');
  const artifact = object(matches[0], 'Unlock artifact');
  if (typeof artifact.size_in_bytes !== 'number' || artifact.size_in_bytes > MAX_RECEIPT_BYTES)
    throw new Error('Unlock receipt artifact is oversized.');
  const trusted = parseTrustedArtifact(
    artifact,
    {
      runId: options.proof.runId,
      headSha: options.proof.headSha,
      runAttempt: 1,
      command: null,
      status: 'completed',
      conclusion: 'success',
    },
    name,
    (options.nowMs ?? Date.now)(),
  );
  const client = createStableGithubClient({ repository: options.proof.repository, token: options.token, fetchImpl });
  return validateUnlockReceipt(
    readUnlockReceiptZip(await client.downloadArtifact(trusted.artifactId)),
    options.proof,
    options,
  );
}
