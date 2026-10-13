import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  assertStagedProductionBaselines,
  formatPromotionReport,
  preflightStagedPromotion,
  reportStagedPromotion,
} from './mobile-ota-promote-staged';
import { verifyServedExport } from './mobile-ota-promote';
import { candidateFixture } from './__tests__/helpers/ota-stable-fixtures';

const temporaryPaths: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const stage = mkdtempSync(join(tmpdir(), 'ota-staged-'));
  temporaryPaths.push(stage);
  const receipt = candidateFixture().receipt;
  for (const platform of ['ios', 'android'] as const) {
    const root = join(stage, platform);
    mkdirSync(root);
    const bundle = `${platform} bundle`;
    receipt.platforms[platform].bundleSha256 = createHash('sha256').update(bundle).digest('hex');
    writeFileSync(join(root, 'bundle.js'), bundle);
    writeFileSync(
      join(root, 'metadata.json'),
      JSON.stringify({
        version: 0,
        bundler: 'metro',
        fileMetadata: { [platform]: { bundle: 'bundle.js', assets: [] } },
      }),
    );
    writeFileSync(
      join(root, 'expoConfig.json'),
      JSON.stringify({
        runtimeVersion: receipt.platforms[platform].runtimeVersion,
        updates: { requestHeaders: { 'expo-app-id': 'a1111111-1111-4111-8111-111111111111' } },
      }),
    );
  }
  writeFileSync(join(stage, 'receipt.json'), JSON.stringify(receipt));
  return { stage, receipt };
}
it('validates both archived hashes and preserves the original receipt and baselines', () => {
  const { stage, receipt } = fixture();
  const original = readFileSync(join(stage, 'receipt.json'), 'utf8');
  expect(preflightStagedPromotion(stage, receipt.commitHash).receipt).toEqual(receipt);
  expect(readFileSync(join(stage, 'receipt.json'), 'utf8')).toBe(original);
  writeFileSync(join(stage, 'android', 'bundle.js'), 'corrupt');
  expect(() => preflightStagedPromotion(stage, receipt.commitHash)).toThrow(/SHA-256/);
});
it('rejects source mismatches and a runtime differing from the archived config', () => {
  const { stage, receipt } = fixture();
  expect(() => preflightStagedPromotion(stage, 'f'.repeat(40))).toThrow(/pinned source/);
  const configPath = join(stage, 'android', 'expoConfig.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, runtimeVersion: 'f'.repeat(40) }));
  expect(() => preflightStagedPromotion(stage, receipt.commitHash)).toThrow(/runtime differs/);
});
it('accepts the fingerprint policy saved by real Expo exports while using resolved receipt runtimes', () => {
  const { stage, receipt } = fixture();
  for (const platform of ['ios', 'android'] as const) {
    const configPath = join(stage, platform, 'expoConfig.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, runtimeVersion: { policy: 'fingerprint' } }));
  }
  expect(preflightStagedPromotion(stage, receipt.commitHash).receipt.platforms).toEqual(receipt.platforms);
});
it.each([
  { policy: 'appVersion' },
  { policy: 'nativeVersion' },
  { policy: 'fingerprint', unexpected: true },
  {},
  ['fingerprint'],
  null,
])('rejects an incompatible or malformed runtime policy: %j', (runtimeVersion) => {
  const { stage, receipt } = fixture();
  const configPath = join(stage, 'android', 'expoConfig.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, runtimeVersion }));
  expect(() => preflightStagedPromotion(stage, receipt.commitHash)).toThrow(/runtime differs/);
});
it('refuses changed production baselines before unlock without rewriting the receipt', async () => {
  const { stage, receipt } = fixture();
  const preflight = preflightStagedPromotion(stage, receipt.commitHash);
  const capture = vi.fn(async () => ({ ...receipt.baselineProductionUpdateIds }));
  await assertStagedProductionBaselines(preflight, 'https://updates.test/manifest', capture);
  capture.mockResolvedValue({ ios: null, android: receipt.baselineProductionUpdateIds.android });
  await expect(assertStagedProductionBaselines(preflight, 'https://updates.test/manifest', capture)).rejects.toThrow(
    /ios production baseline changed/,
  );
  expect(JSON.parse(readFileSync(join(stage, 'receipt.json'), 'utf8'))).toEqual(receipt);
});
it('rejects a different archived app ID before issuing runtime outputs', () => {
  const { stage, receipt } = fixture();
  const configPath = join(stage, 'android', 'expoConfig.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      runtimeVersion: receipt.platforms.android.runtimeVersion,
      updates: { requestHeaders: { 'expo-app-id': 'b1111111-1111-4111-8111-111111111111' } },
    }),
  );
  expect(() => preflightStagedPromotion(stage, receipt.commitHash)).toThrow(/share an app ID/);
});
it('reports both platform outcomes after partial publication and explicitly refuses blind retries', async () => {
  const { stage, receipt } = fixture();
  const verify = vi.fn<typeof verifyServedExport>();
  verify
    .mockResolvedValueOnce('11111111-1111-1111-1111-111111111111')
    .mockRejectedValueOnce(new Error('Android failed'));
  const evidence = await reportStagedPromotion(
    preflightStagedPromotion(stage, receipt.commitHash),
    'https://updates.test/manifest',
    verify,
  );
  expect(evidence.map((entry) => entry.verified)).toEqual([true, false]);
  expect(verify).toHaveBeenCalledTimes(2);
  expect(formatPromotionReport(evidence, 'failure')).toContain('Do not blindly rerun');
  verify
    .mockReset()
    .mockRejectedValueOnce(new Error('iOS failed'))
    .mockResolvedValueOnce('22222222-2222-2222-2222-222222222222');
  const reverse = await reportStagedPromotion(
    preflightStagedPromotion(stage, receipt.commitHash),
    'https://updates.test/manifest',
    verify,
  );
  expect(reverse.map((entry) => entry.verified)).toEqual([false, true]);
});
it('uses the full served bundle, asset and config verifier rather than treating a UUID as success', async () => {
  const { stage, receipt } = fixture();
  const preflight = preflightStagedPromotion(stage, receipt.commitHash);
  const fetchManifest = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const platform = new Headers(init?.headers).get('expo-platform') as 'ios' | 'android';
    return new Response(
      JSON.stringify({
        id: receipt.baselineProductionUpdateIds[platform],
        runtimeVersion: receipt.platforms[platform].runtimeVersion,
        extra: { branch: 'production', expoClient: preflight.exports[platform].expoConfig },
        launchAsset: { hash: createHash('sha256').update(`${platform} bundle`).digest('base64url') },
        assets: platform === 'android' ? [{ hash: 'unexpected asset' }] : [],
      }),
    );
  });
  vi.stubGlobal('fetch', fetchManifest);
  const evidence = await reportStagedPromotion(preflight, 'https://updates.test/manifest');
  expect(evidence[0].verified).toBe(true);
  expect(evidence[1]).toMatchObject({ verified: false, error: expect.stringContaining('asset hashes differ') });
});
