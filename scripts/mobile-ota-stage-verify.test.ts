import { describe, expect, it, vi } from 'vitest';
import { parseStageVerifyArgs, verifyStagedBranches } from './mobile-ota-stage-verify';

const receipt = {
  platforms: {
    ios: { runtimeVersion: 'a'.repeat(40) },
    android: { runtimeVersion: 'b'.repeat(40) },
  },
};
const visible = {
  state: 'branches' as const,
  branches: [{ name: 'pr-staging' }],
  total: 1,
  detail: 'HTTP 200, 1 branch',
};
const absent = { state: 'no-branches' as const, branches: [], total: 0, detail: 'HTTP 200, 0 branches' };

describe('staged OTA visibility gate', () => {
  it('requires the updates URL and exactly one receipt path', () => {
    expect(parseStageVerifyArgs(['ota-stage/receipt.json'], 'https://updates.example/manifest')).toEqual({
      receiptPath: 'ota-stage/receipt.json',
      serverUrl: 'https://updates.example/manifest',
    });
    expect(() => parseStageVerifyArgs(['receipt.json'], undefined)).toThrow('EXPO_UPDATES_URL is required');
    expect(() => parseStageVerifyArgs([], 'https://updates.example/manifest')).toThrow('one staged receipt path');
    expect(() => parseStageVerifyArgs(['first', 'second'], 'https://updates.example/manifest')).toThrow(
      'one staged receipt path',
    );
  });

  it('requires both platform fingerprints to be offered and retries propagation', async () => {
    const probe = vi.fn().mockResolvedValueOnce(absent).mockResolvedValueOnce(visible).mockResolvedValueOnce(visible);
    const sleepMs = vi.fn(async () => {});
    await verifyStagedBranches(receipt, 'https://updates.example/manifest', { probe, delaysMs: [10], sleepMs });
    expect(probe.mock.calls).toEqual([
      ['https://updates.example', receipt.platforms.ios.runtimeVersion, 'ios'],
      ['https://updates.example', receipt.platforms.ios.runtimeVersion, 'ios'],
      ['https://updates.example', receipt.platforms.android.runtimeVersion, 'android'],
    ]);
    expect(sleepMs).toHaveBeenCalledExactlyOnceWith(10);
  });

  it('fails closed when a platform is absent or its fingerprint is invalid', async () => {
    const probe = vi.fn().mockResolvedValueOnce(visible).mockResolvedValueOnce(absent);
    await expect(
      verifyStagedBranches(receipt, 'https://updates.example/manifest', { probe, delaysMs: [] }),
    ).rejects.toThrow(`android staged branch is not offered for ${receipt.platforms.android.runtimeVersion}`);
    expect(probe).toHaveBeenCalledTimes(2);
    await expect(
      verifyStagedBranches(
        { platforms: { ...receipt.platforms, android: { runtimeVersion: 'invalid' } } },
        'https://updates.example/manifest',
        { probe: vi.fn().mockResolvedValue(visible), delaysMs: [] },
      ),
    ).rejects.toThrow('Missing or invalid android runtimeVersion');
  });
});
