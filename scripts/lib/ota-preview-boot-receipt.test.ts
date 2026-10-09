import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectPreviewReceipt, recordPreviewPlatformReceipt } from './ota-preview-boot-receipt';

const SHA = 'a'.repeat(40);
const RTV = 'b'.repeat(40);
const UPDATE = '12345678-1234-1234-1234-123456789abc';
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function fixture() {
  const exportDir = mkdtempSync(join(tmpdir(), 'preview-export-'));
  directories.push(exportDir);
  const bytes = 'the exact uploaded preview bundle';
  writeFileSync(join(exportDir, 'main.hbc'), bytes);
  writeFileSync(
    join(exportDir, 'metadata.json'),
    JSON.stringify({ version: 0, bundler: 'metro', fileMetadata: { android: { bundle: 'main.hbc', assets: [] } } }),
  );
  writeFileSync(
    join(exportDir, 'expoConfig.json'),
    JSON.stringify({ updates: { requestHeaders: { 'expo-app-id': '007e6fd7-f200-448c-9449-8d48ba5d51fc' } } }),
  );
  const options = {
    platform: 'android' as const,
    runtimeVersion: RTV,
    commitHash: SHA,
    branch: 'pr-6131',
    exportDir,
    manifestUrl: 'https://updates.example/manifest',
    outPath: join(exportDir, 'receipt.json'),
  };
  const manifest = {
    id: UPDATE,
    createdAt: '2026-10-09T00:00:00Z',
    runtimeVersion: RTV,
    extra: { branch: 'pr-6131' },
    launchAsset: { hash: createHash('sha256').update(bytes).digest('base64url') },
  };
  return { options, manifest };
}

describe('preview publisher receipts', () => {
  it('records the actual publish runtime, exported bytes and public served UUID', async () => {
    const { options, manifest } = fixture();
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('expo-runtime-version')).toBe(RTV);
      expect(new Headers(init?.headers).get('xprem-branch')).toBe('pr-6131');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return Response.json(manifest);
    });
    const receipt = await recordPreviewPlatformReceipt(options, fetchImpl);
    expect(receipt).toEqual({
      platform: 'android',
      runtimeVersion: RTV,
      commitHash: SHA,
      branch: 'pr-6131',
      updateId: UPDATE,
      bundleSha256: createHash('sha256').update('the exact uploaded preview bundle').digest('hex'),
    });
    expect(JSON.parse(readFileSync(options.outPath, 'utf8'))).toEqual(receipt);
  });

  it.each(['branch', 'runtime', 'bundle'])(
    'refuses a moved or mismatched %s, leaving no receipt',
    async (difference) => {
      const { options, manifest } = fixture();
      if (difference === 'branch') manifest.extra.branch = 'pr-1';
      if (difference === 'runtime') manifest.runtimeVersion = 'c'.repeat(40);
      if (difference === 'bundle') manifest.launchAsset.hash = 'wrong-bundle';
      await expect(recordPreviewPlatformReceipt(options, async () => Response.json(manifest))).rejects.toThrow(
        'head moved',
      );
      expect(existsSync(options.outPath)).toBe(false);
    },
  );

  it('refuses a rollback/no-update response even with valid commit metadata elsewhere', async () => {
    const { options } = fixture();
    await expect(recordPreviewPlatformReceipt(options, async () => Response.json({ commitHash: SHA }))).rejects.toThrow(
      'did not serve',
    );
  });

  it.each(['../outside.hbc', '/outside.hbc', 'nested\\outside.hbc'])(
    'rejects unsafe exported paths %s before a manifest request',
    async (bundle) => {
      const { options } = fixture();
      writeFileSync(
        join(options.exportDir, 'metadata.json'),
        JSON.stringify({ fileMetadata: { android: { bundle } } }),
      );
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(recordPreviewPlatformReceipt(options, fetchImpl)).rejects.toThrow('Unsafe');
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('rejects a symbolic bundle before attesting it', async () => {
    const { options } = fixture();
    rmSync(join(options.exportDir, 'main.hbc'));
    symlinkSync('expoConfig.json', join(options.exportDir, 'main.hbc'));
    await expect(recordPreviewPlatformReceipt(options)).rejects.toThrow('Symbolic');
  });

  it('times out a stalled manifest body after 30 seconds', async () => {
    vi.useFakeTimers();
    const { options } = fixture();
    const fetchImpl = vi.fn<typeof fetch>(
      async (_url, init) =>
        ({
          ok: true,
          status: 200,
          text: () =>
            new Promise<string>((_resolve, reject) =>
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
            ),
        }) as Response,
    );
    const result = expect(recordPreviewPlatformReceipt(options, fetchImpl)).rejects.toThrow('30 seconds');
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(existsSync(options.outPath)).toBe(false);
  });

  it('requires both platform receipts to agree with full pinned SHA and branch', () => {
    const ios = {
      platform: 'ios',
      commitHash: SHA,
      branch: 'pr-6131',
      runtimeVersion: RTV,
      bundleSha256: 'c'.repeat(64),
      updateId: UPDATE,
    };
    const android = { ...ios, platform: 'android', runtimeVersion: 'd'.repeat(40) };
    const metadata = { headSha: SHA, branch: 'pr-6131', runId: 50, deploymentId: 60 };
    expect(collectPreviewReceipt(ios, android, metadata).platforms.android.runtimeVersion).toBe('d'.repeat(40));
    expect(() => collectPreviewReceipt(ios, { ...android, commitHash: 'e'.repeat(40) }, metadata)).toThrow('disagree');
    expect(() => collectPreviewReceipt(ios, undefined, metadata)).toThrow();
  });
});
