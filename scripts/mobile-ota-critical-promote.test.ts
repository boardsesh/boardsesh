import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCriticalArgs, promoteCriticalStagedOta } from './mobile-ota-critical-promote';
import type { CriticalPromotionOptions } from './mobile-ota-critical-promote';
import { initialStableState } from './lib/ota-stable';
import type { OtaPlatform } from './lib/ota-publish-protocol';
import type { XpremRolloutUpdate, XpremUpdateDetails } from './lib/xprem-admin.mts';
import type { promoteArchivedOta } from './mobile-ota-promote';
import { activeFixture, candidateFixture } from './__tests__/helpers/ota-stable-fixtures';
import { fakeXprem } from './__tests__/helpers/fake-xprem';

const APP_ID = 'a1111111-1111-4111-8111-111111111111';
const PLATFORMS = ['ios', 'android'] as const;
const revertedIds = {
  ios: '55555555-5555-5555-5555-555555555555',
  android: '66666666-6666-6666-6666-666666666666',
};
const temporaryPaths: string[] = [];
afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const stage = mkdtempSync(join(tmpdir(), 'ota-critical-'));
  temporaryPaths.push(stage);
  const receipt = structuredClone(candidateFixture().receipt);
  receipt.commitHash = 'f'.repeat(40);
  const state = { ...initialStableState(), checkpointRunId: '201', active: structuredClone(activeFixture()) };
  const manifests = {} as Record<OtaPlatform, Record<string, unknown>>;
  const controls = {} as Record<OtaPlatform, XpremUpdateDetails>;
  const canaries = {} as Record<OtaPlatform, XpremUpdateDetails>;
  const live: XpremRolloutUpdate[] = PLATFORMS.map((platform) => ({
    platform,
    updateId: platform === 'ios' ? '31' : '32',
    controlUpdateId: platform === 'ios' ? '1' : '2',
    percentage: 5,
    createdAt: state.active.startedAt,
  }));
  for (const platform of PLATFORMS) {
    const root = join(stage, platform);
    mkdirSync(root);
    const bundle = `${platform} critical bundle`;
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
    const expoClient = {
      runtimeVersion: receipt.platforms[platform].runtimeVersion,
      updates: { requestHeaders: { 'expo-app-id': APP_ID, 'expo-channel-name': 'production' } },
    };
    writeFileSync(join(root, 'expoConfig.json'), JSON.stringify(expoClient));
    manifests[platform] = {
      id: receipt.baselineProductionUpdateIds[platform],
      runtimeVersion: receipt.platforms[platform].runtimeVersion,
      launchAsset: { hash: createHash('sha256').update(`${platform} stable bundle`).digest('base64url') },
      assets: [
        { hash: createHash('sha256').update(`${platform} stable asset 1`).digest('base64url'), url: 'https://old/1' },
        { hash: createHash('sha256').update(`${platform} stable asset 2`).digest('base64url'), url: 'https://old/2' },
      ],
      extra: { branch: 'production', expoClient },
    };
    controls[platform] = {
      updateId: platform === 'ios' ? '1' : '2',
      updateUUID: receipt.baselineProductionUpdateIds[platform],
      platform,
      commitHash: '0'.repeat(40),
    };
    canaries[platform] = {
      updateId: platform === 'ios' ? '31' : '32',
      updateUUID: platform === 'ios' ? '33333333-3333-3333-3333-333333333333' : '44444444-4444-4444-4444-444444444444',
      platform,
      commitHash: state.active.candidate.receipt.commitHash,
    };
  }
  writeFileSync(join(stage, 'receipt.json'), JSON.stringify(receipt));
  const client = fakeXprem({}).client;
  client.getRuntimeVersions = vi.fn(async () =>
    PLATFORMS.map((platform) => receipt.platforms[platform].runtimeVersion),
  );
  client.getUpdateRollout = vi.fn(async (_branch, runtimeVersion) => {
    const updates = live.filter(
      (rollout) => receipt.platforms[rollout.platform as OtaPlatform].runtimeVersion === runtimeVersion,
    );
    return { active: updates.length > 0, updates: updates.map((rollout) => ({ ...rollout })) };
  });
  client.getUpdateDetails = vi.fn(async (_branch, _runtimeVersion, updateId) => {
    const details = [...Object.values(controls), ...Object.values(canaries)].find(
      (entry) => String(entry.updateId) === String(updateId),
    );
    if (!details) throw new Error('Unexpected update details');
    return { ...details };
  });
  const revert = vi.fn(async (_branch: string, _runtimeVersion: string, updateId: string | number) => {
    const index = live.findIndex((rollout) => String(rollout.updateId) === String(updateId));
    if (index < 0) throw new Error('Unexpected revert');
    const platform = live[index].platform as OtaPlatform;
    live.splice(index, 1);
    manifests[platform].id = revertedIds[platform];
  });
  client.revertUpdateRollout = revert;
  const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
    const platform = new Headers(init?.headers).get('expo-platform') as OtaPlatform;
    return Response.json(manifests[platform]);
  });
  const promote = vi.fn<typeof promoteArchivedOta>(async () => undefined);
  const options: CriticalPromotionOptions = {
    stage,
    sourceSha: receipt.commitHash,
    state,
    loadedStateRunId: state.checkpointRunId,
    manifestUrl: 'https://updates.example/manifest',
    token: 'upload-token',
    client,
    fetchImpl,
    promote,
  };
  const evidence = () =>
    JSON.parse(readFileSync(join(stage, 'critical-supersession.json'), 'utf8')) as {
      status: string;
      error?: string;
      planned: unknown[];
      platforms: Partial<Record<OtaPlatform, { requested: boolean; reverted?: boolean; attestedUpdateId?: string }>>;
    };
  return { options, stage, receipt, state, manifests, live, controls, canaries, client, revert, promote, evidence };
}

describe('critical frozen publication', () => {
  it('reports a concurrent evidence owner without overwriting its file or writing production', async () => {
    const test = fixture();
    test.live.length = 0;
    const originalFetch = test.options.fetchImpl!;
    const evidencePath = join(test.stage, 'critical-supersession.json');
    let competingOwnerCreated = false;
    test.options.fetchImpl = async (input, init) => {
      if (!competingOwnerCreated) {
        writeFileSync(evidencePath, 'competing owner evidence', { flag: 'wx' });
        competingOwnerCreated = true;
      }
      return originalFetch(input, init);
    };
    await expect(promoteCriticalStagedOta(test.options)).rejects.toThrow(
      'Critical publication evidence already exists',
    );
    expect(readFileSync(evidencePath, 'utf8')).toBe('competing owner evidence');
    expect(test.revert).not.toHaveBeenCalled();
    expect(test.promote).not.toHaveBeenCalled();
  });
  it('uses the untouched original receipt when no rollout is live', async () => {
    const test = fixture();
    test.live.length = 0;
    test.options.state = initialStableState();
    test.options.loadedStateRunId = '0';
    const original = readFileSync(join(test.stage, 'receipt.json'), 'utf8');
    await promoteCriticalStagedOta(test.options);
    expect(test.revert).not.toHaveBeenCalled();
    expect(test.promote).toHaveBeenCalledWith(
      expect.objectContaining({ receiptPath: join(test.stage, 'receipt.json'), branch: 'production' }),
    );
    expect(test.promote.mock.calls[0][0]).not.toHaveProperty('rollout');
    expect(readFileSync(join(test.stage, 'receipt.json'), 'utf8')).toBe(original);
    expect(existsSync(join(test.stage, 'critical-receipt.json'))).toBe(false);
    expect(test.evidence().status).toBe('complete');
  });

  it('persists both control snapshots before either exact-ID revert and proves each replacement', async () => {
    const test = fixture();
    const original = readFileSync(join(test.stage, 'receipt.json'), 'utf8');
    const originalRevert = test.revert.getMockImplementation()!;
    test.revert.mockImplementation(async (branch, runtimeVersion, updateId) => {
      expect(test.evidence().planned).toHaveLength(2);
      const platform = String(updateId) === '31' ? 'ios' : 'android';
      expect(test.evidence().platforms[platform]?.requested).toBe(true);
      if (platform === 'android') expect(test.evidence().platforms.ios?.attestedUpdateId).toBe(revertedIds.ios);
      expect(existsSync(join(test.stage, 'critical-receipt.json'))).toBe(false);
      await originalRevert(branch, runtimeVersion, updateId);
      // Server republish may reorder assets and move their URLs without changing bytes.
      const assets = test.manifests[platform].assets as { hash: string; url: string }[];
      test.manifests[platform].assets = assets.reverse().map((asset) => ({ ...asset, url: 'https://new/asset' }));
      test.manifests[platform].createdAt = '2026-10-20T00:00:00Z';
    });
    await promoteCriticalStagedOta(test.options);
    expect(test.revert.mock.calls.map((call) => call[2])).toEqual(['31', '32']);
    const derived = JSON.parse(readFileSync(join(test.stage, 'critical-receipt.json'), 'utf8')) as unknown;
    expect(derived).toEqual({ ...test.receipt, baselineProductionUpdateIds: revertedIds });
    expect(readFileSync(join(test.stage, 'receipt.json'), 'utf8')).toBe(original);
    expect(test.promote).toHaveBeenCalledWith(
      expect.objectContaining({ receiptPath: join(test.stage, 'critical-receipt.json') }),
    );
    expect(test.evidence().status).toBe('complete');
  });

  it('keeps the original baseline for a platform whose bytes were unchanged by the canary', async () => {
    const test = fixture();
    delete test.state.active.updateIds.android;
    test.state.active.unchangedPlatforms.android = test.receipt.baselineProductionUpdateIds.android!;
    test.live.splice(1, 1);
    await promoteCriticalStagedOta(test.options);
    const derived = JSON.parse(readFileSync(join(test.stage, 'critical-receipt.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(derived.baselineProductionUpdateIds).toEqual({
      ios: revertedIds.ios,
      android: test.receipt.baselineProductionUpdateIds.android,
    });
    expect(test.revert).toHaveBeenCalledTimes(1);
  });

  it('validates both archives before touching live rollouts', async () => {
    const test = fixture();
    writeFileSync(join(test.stage, 'android', 'bundle.js'), 'corrupt staged bytes');
    await expect(promoteCriticalStagedOta(test.options)).rejects.toThrow(/SHA-256/);
    expect(test.revert).not.toHaveBeenCalled();
    expect(test.promote).not.toHaveBeenCalled();
  });

  it('rejects a checkpoint whose producer differs from the trusted artifact run', async () => {
    const test = fixture();
    test.options.loadedStateRunId = '202';
    await expect(promoteCriticalStagedOta(test.options)).rejects.toThrow(/trusted artifact producer/);
    expect(test.revert).not.toHaveBeenCalled();
    expect(test.promote).not.toHaveBeenCalled();
    expect(existsSync(join(test.stage, 'critical-supersession.json'))).toBe(false);
  });

  it('checks the second platform baseline before reverting the first', async () => {
    const test = fixture();
    test.manifests.android.id = revertedIds.android;
    await expect(promoteCriticalStagedOta(test.options)).rejects.toThrow(/android production baseline changed/);
    expect(test.revert).not.toHaveBeenCalled();
    expect(test.promote).not.toHaveBeenCalled();
    expect(existsSync(join(test.stage, 'critical-supersession.json'))).toBe(false);
  });

  it.each([
    'foreign numeric ID',
    'wrong checkpoint runtime',
    'wrong commit',
    'wrong canary platform',
    'wrong canary UUID',
    'wrong control UUID',
    'wrong control platform',
    'different staged control',
    'missing control',
    'reverting checkpoint',
    'missing ownership',
  ])('refuses %s before any production mutation', async (scenario) => {
    const test = fixture();
    // Keep iOS valid so a second-platform problem must still prevent the first write.
    if (scenario === 'foreign numeric ID') test.live[1].updateId = '99';
    if (scenario === 'wrong checkpoint runtime')
      test.state.active.candidate.receipt.platforms.android.runtimeVersion = '9'.repeat(40);
    if (scenario === 'wrong commit') test.canaries.android.commitHash = '9'.repeat(40);
    if (scenario === 'wrong canary platform') test.canaries.android.platform = 'ios';
    if (scenario === 'wrong canary UUID') test.canaries.android.updateUUID = 'not-a-uuid';
    if (scenario === 'wrong control UUID') test.controls.android.updateUUID = revertedIds.android;
    if (scenario === 'wrong control platform') test.controls.android.platform = 'ios';
    if (scenario === 'different staged control')
      test.state.active.candidate.receipt.baselineProductionUpdateIds.android = revertedIds.android;
    if (scenario === 'missing control') test.live[1].controlUpdateId = null;
    if (scenario === 'reverting checkpoint') test.state.active.phase = 'reverting';
    if (scenario === 'missing ownership') test.options.state = { ...test.state, active: null };
    await expect(promoteCriticalStagedOta(test.options)).rejects.toThrow();
    expect(test.revert).not.toHaveBeenCalled();
    expect(test.promote).not.toHaveBeenCalled();
    expect(existsSync(join(test.stage, 'critical-receipt.json'))).toBe(false);
  });

  it.each(['runtime', 'launch hash', 'assets', 'config', 'branch'])(
    'refuses changed %s after an owned revert',
    async (scenario) => {
      const test = fixture();
      const originalRevert = test.revert.getMockImplementation()!;
      test.revert.mockImplementation(async (branch, runtimeVersion, updateId) => {
        await originalRevert(branch, runtimeVersion, updateId);
        if (scenario === 'runtime') test.manifests.ios.runtimeVersion = '9'.repeat(40);
        if (scenario === 'launch hash') test.manifests.ios.launchAsset = { hash: 'A'.repeat(43) };
        if (scenario === 'assets') test.manifests.ios.assets = [];
        if (scenario === 'config') {
          const extra = test.manifests.ios.extra as Record<string, unknown>;
          extra.expoClient = { ...(extra.expoClient as Record<string, unknown>), name: 'foreign config' };
        }
        if (scenario === 'branch') (test.manifests.ios.extra as Record<string, unknown>).branch = 'foreign';
      });
      await expect(promoteCriticalStagedOta(test.options)).rejects.toThrow();
      expect(test.revert).toHaveBeenCalledTimes(1);
      expect(test.promote).not.toHaveBeenCalled();
      expect(existsSync(join(test.stage, 'critical-receipt.json'))).toBe(false);
      expect(test.evidence()).toMatchObject({
        status: 'failed',
        platforms: { ios: { requested: true, reverted: true } },
      });
      expect(test.evidence().platforms.ios?.attestedUpdateId).toBeUndefined();
    },
  );

  it('keeps proven iOS recovery evidence when Android revert fails', async () => {
    const test = fixture();
    const originalRevert = test.revert.getMockImplementation()!;
    test.revert.mockImplementation(async (branch, runtimeVersion, updateId) => {
      if (String(updateId) === '32') throw new Error('Android revert failed');
      await originalRevert(branch, runtimeVersion, updateId);
    });
    await expect(promoteCriticalStagedOta(test.options)).rejects.toThrow(/Android revert failed/);
    expect(test.evidence()).toMatchObject({
      status: 'failed',
      platforms: { ios: { reverted: true, attestedUpdateId: revertedIds.ios }, android: { requested: true } },
    });
    expect(test.evidence().platforms.android?.reverted).toBeUndefined();
    expect(existsSync(join(test.stage, 'critical-receipt.json'))).toBe(false);
    expect(test.promote).not.toHaveBeenCalled();
    const writes = test.revert.mock.calls.length;
    await expect(promoteCriticalStagedOta(test.options)).rejects.toThrow(/evidence already exists/);
    expect(test.revert).toHaveBeenCalledTimes(writes);
  });

  it('refuses a second-platform head that changes after the first owned revert', async () => {
    const test = fixture();
    const originalRevert = test.revert.getMockImplementation()!;
    test.revert.mockImplementation(async (branch, runtimeVersion, updateId) => {
      await originalRevert(branch, runtimeVersion, updateId);
      test.manifests.android.id = revertedIds.android;
    });
    await expect(promoteCriticalStagedOta(test.options)).rejects.toThrow(/android production baseline changed/);
    expect(test.revert).toHaveBeenCalledTimes(1);
    expect(test.promote).not.toHaveBeenCalled();
    expect(test.evidence().platforms.ios?.attestedUpdateId).toBe(revertedIds.ios);
  });

  it('refuses a foreign rollout introduced after the first owned revert', async () => {
    const test = fixture();
    const originalRevert = test.revert.getMockImplementation()!;
    test.revert.mockImplementation(async (branch, runtimeVersion, updateId) => {
      await originalRevert(branch, runtimeVersion, updateId);
      test.live[0].updateId = '99';
    });
    await expect(promoteCriticalStagedOta(test.options)).rejects.toThrow(/rollout changed after critical preflight/);
    expect(test.revert).toHaveBeenCalledTimes(1);
    expect(test.promote).not.toHaveBeenCalled();
    expect(test.evidence().platforms.ios?.attestedUpdateId).toBe(revertedIds.ios);
  });

  it.each(['launchAsset', 'assets', 'extra'])('rejects malformed control %s before a revert', async (field) => {
    const test = fixture();
    test.manifests.android[field] = null;
    await expect(promoteCriticalStagedOta(test.options)).rejects.toThrow();
    expect(test.revert).not.toHaveBeenCalled();
    expect(test.promote).not.toHaveBeenCalled();
  });
});

it('requires explicit stage, source and trusted-state paths and rejects duplicate arguments', () => {
  expect(
    parseCriticalArgs([
      '--stage',
      'ota-stage',
      '--source-sha',
      'f'.repeat(40),
      '--state',
      'controller-state/state.json',
      '--loaded-state-run-id',
      '201',
    ]),
  ).toEqual({
    stage: 'ota-stage',
    sourceSha: 'f'.repeat(40),
    statePath: 'controller-state/state.json',
    loadedStateRunId: '201',
  });
  expect(() => parseCriticalArgs(['--stage', 'ota-stage'])).toThrow(/required/);
  expect(() => parseCriticalArgs(['--stage', 'ota-stage', '--stage', 'other'])).toThrow(/duplicate/);
});
