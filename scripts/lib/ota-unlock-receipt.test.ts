import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  downloadUnlockReceipt,
  readControlHead,
  readUnlockReceiptZip,
  unlockArtifactName,
  validateUnlockReceipt,
} from './ota-unlock-receipt';
import { restoredIds, unlockExpected, unlockProof, unlockReceipt } from '../__tests__/helpers/ota-unlock-fixtures';

const requestHref = (request: RequestInfo | URL): string =>
  request instanceof URL ? request.href : typeof request === 'string' ? request : request.url;

function archive(input: unknown, name = 'receipt.json'): Uint8Array {
  const result = spawnSync(
    'python3',
    [
      '-c',
      'import io,sys,zipfile; output=io.BytesIO(); archive=zipfile.ZipFile(output,"w"); archive.writestr(sys.argv[1],sys.stdin.buffer.read()); archive.close(); sys.stdout.buffer.write(output.getvalue())',
      name,
    ],
    { input: JSON.stringify(input) },
  );
  if (result.status !== 0) throw new Error('Could not create test ZIP');
  return new Uint8Array(result.stdout);
}
function artifactFixture() {
  const receipt = unlockReceipt();
  const zip = archive(receipt);
  const artifact = {
    id: 71,
    name: unlockArtifactName(unlockProof.requestId),
    expired: false,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    size_in_bytes: zip.length,
    workflow_run: { id: unlockProof.runId, head_sha: unlockProof.headSha, head_branch: 'main' },
  };
  const listing = { total_count: 1, artifacts: [artifact] };
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    if (requestHref(input).endsWith('/zip')) return new Response(new Uint8Array(zip));
    return Response.json(listing);
  });
  const run = () => downloadUnlockReceipt({ ...unlockExpected, proof: unlockProof, token: 'test-token', fetchImpl });
  return { receipt, artifact, listing, fetchImpl, run };
}

describe('trusted unlock receipt', () => {
  it('accepts only the exact request, main run, app, platforms, runtimes and original controls', () => {
    expect(validateUnlockReceipt(unlockReceipt(), unlockProof, unlockExpected)).toEqual(unlockReceipt());
    for (const change of [
      { repository: 'other/repository' },
      { runId: 999 },
      { runAttempt: 2 },
      { headSha: 'c'.repeat(40) },
      { requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { branch: 'pr-staging' },
    ])
      expect(() => validateUnlockReceipt({ ...unlockReceipt(), ...change }, unlockProof, unlockExpected)).toThrow();
    for (const change of [
      { runtimeVersion: 'c'.repeat(40) },
      { originalUpdateId: restoredIds.ios },
      { restoredUpdateId: 'bad' },
      { contentSha256: null },
    ]) {
      const receipt = unlockReceipt();
      Object.assign(receipt.platforms.ios, change);
      expect(() => validateUnlockReceipt(receipt, unlockProof, unlockExpected)).toThrow();
    }
  });
  it('never lets a no-op authorize a replacement UUID with the same bytes', () => {
    const receipt = unlockReceipt();
    receipt.platforms.ios.mode = 'unchanged';
    expect(() => validateUnlockReceipt(receipt, unlockProof, unlockExpected)).toThrow('no-op');
  });
  it('requires a reverted control to expose a new UUID', () => {
    const receipt = unlockReceipt();
    receipt.platforms.ios.restoredUpdateId = receipt.platforms.ios.originalUpdateId;
    expect(() => validateUnlockReceipt(receipt, unlockProof, unlockExpected)).toThrow('no valid restoration');
  });
  it('downloads only one unexpired artifact from the pinned main run', async () => {
    const { run, fetchImpl, receipt } = artifactFixture();
    expect(await run()).toEqual(receipt);
    expect(fetchImpl.mock.calls.map(([request]) => requestHref(request))).toEqual([
      'https://api.github.com/repos/boardsesh/boardsesh/actions/runs/42/artifacts?per_page=100',
      'https://api.github.com/repos/boardsesh/boardsesh/actions/artifacts/71/zip',
    ]);
  });
  it('accepts a complete 100-artifact page with one matching receipt', async () => {
    const { run, listing, artifact, receipt } = artifactFixture();
    listing.artifacts.push(
      ...Array.from({ length: 99 }, (_, index) => ({ ...artifact, id: index + 100, name: `unrelated-${index}` })),
    );
    listing.total_count = 100;
    expect(await run()).toEqual(receipt);
  });
  it.each([
    'missing',
    'duplicate',
    'expired',
    'foreign-run',
    'foreign-sha',
    'foreign-branch',
    'oversized',
    'incomplete',
    'too-many',
  ])('fails closed for %s artifacts before downloading', async (failure) => {
    const { run, listing, artifact, fetchImpl } = artifactFixture();
    if (failure === 'missing') {
      listing.artifacts = [];
      listing.total_count = 0;
    }
    if (failure === 'duplicate') {
      listing.artifacts.push({ ...artifact });
      listing.total_count = 2;
    }
    if (failure === 'expired') artifact.expired = true;
    if (failure === 'foreign-run') artifact.workflow_run.id = 99;
    if (failure === 'foreign-sha') artifact.workflow_run.head_sha = 'c'.repeat(40);
    if (failure === 'foreign-branch') artifact.workflow_run.head_branch = 'release/next';
    if (failure === 'oversized') artifact.size_in_bytes = 65_537;
    if (failure === 'incomplete') listing.total_count = 2;
    if (failure === 'too-many') {
      listing.artifacts.push(
        ...Array.from({ length: 100 }, (_, index) => ({ ...artifact, id: index + 100, name: `unrelated-${index}` })),
      );
      listing.total_count = 101;
    }
    await expect(run()).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('reads one bounded JSON member and rejects other ZIP paths or oversized bytes', () => {
    expect(readUnlockReceiptZip(archive(unlockReceipt()))).toEqual(unlockReceipt());
    expect(() => readUnlockReceiptZip(archive({}, '../receipt.json'))).toThrow('ZIP is invalid');
    expect(() => readUnlockReceiptZip(new Uint8Array(65_537))).toThrow('oversized');
  });
});

describe('control content attestation', () => {
  it('includes bundle, sorted assets and Expo config while excluding the update UUID', async () => {
    const expoClient = {
      updates: { requestHeaders: { 'expo-app-id': unlockExpected.appId, 'expo-channel-name': 'production' } },
      name: 'Boardsesh',
    };
    const manifest = {
      id: unlockExpected.baselines.ios,
      runtimeVersion: unlockExpected.runtimes.ios,
      launchAsset: { hash: 'bundle-hash' },
      assets: [{ hash: 'second' }, { hash: 'first' }],
      extra: { branch: 'production', expoClient },
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(manifest));
    const options = {
      appId: unlockExpected.appId,
      platform: 'ios' as const,
      runtimeVersion: unlockExpected.runtimes.ios,
      manifestUrl: 'https://updates.test/manifest',
      fetchImpl,
    };
    const original = await readControlHead(options);
    const controlHeaders = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    expect(controlHeaders.get('EAS-Client-ID')).toBeNull();
    expect(controlHeaders.get('expo-platform')).toBe('ios');
    expect(controlHeaders.get('expo-runtime-version')).toBe(unlockExpected.runtimes.ios);
    expect(controlHeaders.get('expo-channel-name')).toBe('production');
    manifest.id = restoredIds.ios;
    manifest.assets.reverse();
    expect(await readControlHead(options)).toEqual({ ...original, updateId: restoredIds.ios });
    manifest.launchAsset.hash = 'different';
    expect((await readControlHead(options)).contentSha256).not.toBe(original.contentSha256);
    manifest.launchAsset.hash = 'bundle-hash';
    manifest.extra.expoClient.name = 'Different config';
    expect((await readControlHead(options)).contentSha256).not.toBe(original.contentSha256);
    manifest.extra.expoClient.name = 'Boardsesh';
    manifest.assets[0].hash = 'different asset';
    expect((await readControlHead(options)).contentSha256).not.toBe(original.contentSha256);
  });
});
