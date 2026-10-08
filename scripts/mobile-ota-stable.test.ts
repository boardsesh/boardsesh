import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialStableState } from './lib/ota-stable';
import { tickStable, abortStable, parseStableArgs, saveState, readState } from './mobile-ota-stable';
import type { XpremAdminClient } from './lib/xprem-admin.mts';
import { activeFixture, candidateFixture } from './__tests__/helpers/ota-stable-fixtures';
import { desiredOtaState } from '../infra/ota/config';

const mocks = vi.hoisted(() => ({ baseline: vi.fn(), promote: vi.fn(), validate: vi.fn(), unchanged: vi.fn() }));
vi.mock('./mobile-ota-promote.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-ota-promote.ts')>()),
  captureProductionBaseline: mocks.baseline,
  promoteArchivedOta: mocks.promote,
  validateExport: mocks.validate,
  verifyUnchangedPlatforms: mocks.unchanged,
}));

const nativeUUIDs = { ios: '33333333-3333-3333-3333-333333333333', android: '44444444-4444-4444-4444-444444444444' };
const tempPaths: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.promote.mockResolvedValue(undefined);
  mocks.unchanged.mockResolvedValue(undefined);
  mocks.baseline.mockResolvedValue(candidateFixture().receipt.baselineProductionUpdateIds);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});
function writePromotionRecord(path: string, record: Record<string, unknown>): void {
  const previous = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...previous, ...record }));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ota-stable-test-'));
  tempPaths.push(root);
  const state = { ...initialStableState(), active: activeFixture() };
  const candidate = state.active.candidate;
  const live = ['ios', 'android'].map((platform) => ({
    updateId: platform === 'ios' ? '31' : '32',
    platform,
    percentage: 5,
    controlUpdateId: platform === 'ios' ? '1' : '2',
    createdAt: state.active.startedAt,
  }));
  const baselineIds = { ...state.active.candidate.receipt.baselineProductionUpdateIds };
  mocks.baseline.mockImplementation(async () => ({ ...baselineIds }));
  const getUpdateRollout = vi.fn(async (_branch: string, runtime: string) => ({
    active: true,
    updates: live.filter(
      (entry) =>
        state.active.candidate.receipt.platforms[entry.platform as 'ios' | 'android'].runtimeVersion === runtime,
    ),
  }));
  const setUpdateRolloutPercentage = vi.fn(async (_branch: string, runtime: string, percentage: number, id: string) => {
    const index = live.findIndex((entry) => entry.updateId === id);
    if (index < 0) throw new Error('No live rollout');
    if (state.active.candidate.receipt.platforms[live[index].platform as 'ios' | 'android'].runtimeVersion !== runtime)
      throw new Error('Wrong runtime');
    live[index].percentage = percentage;
    if (percentage === 100) {
      const platform = live[index].platform as 'ios' | 'android';
      baselineIds[platform] = nativeUUIDs[platform];
      live.splice(index, 1);
    }
  });
  const revertUpdateRollout = vi.fn(async (_branch: string, _runtime: string, id: string) => {
    const index = live.findIndex((entry) => entry.updateId === id);
    if (index < 0) throw new Error('No live rollout');
    const platform = live[index].platform as 'ios' | 'android';
    baselineIds[platform] =
      platform === 'ios' ? '55555555-5555-5555-5555-555555555555' : '66666666-6666-6666-6666-666666666666';
    live.splice(index, 1);
  });
  const client = {
    getRuntimeVersions: vi.fn(async () =>
      Object.values(candidate.receipt.platforms).map((entry) => entry.runtimeVersion),
    ),
    getUpdateRollout,
    setUpdateRolloutPercentage,
    revertUpdateRollout,
    getUpdateDetails: vi.fn(async (_branch: string, _runtime: string, id: string) => {
      const platform = ['31', '1'].includes(id) ? 'ios' : 'android';
      return {
        updateId: id,
        platform,
        updateUUID: ['31', '32'].includes(id)
          ? nativeUUIDs[platform]
          : state.active.candidate.receipt.baselineProductionUpdateIds[platform],
        commitHash: ['31', '32'].includes(id) ? state.active.candidate.receipt.commitHash : 'f'.repeat(40),
      };
    }),
    getUpdateHealth: vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, { devicesOnUpdate: 20, successfulDevices: 20, faultyDevices: 0 }])),
    ),
    getUpdateHealthHistory: vi.fn(async () => ({ source: 'state', latest: {} })),
  };
  const save = vi.fn();
  const options: Parameters<typeof tickStable>[0] = {
    client: client as unknown as XpremAdminClient,
    state,
    stagePath: root,
    manifestUrl: 'https://updates.test/manifest',
    token: 'publish-token',
    apply: true,
    now: new Date('2026-10-09T02:00:00Z'),
    clock: () => new Date('2026-10-09T02:01:00Z'),
    save,
    log: vi.fn(),
  };
  return { options, client, live, baselineIds, save, root };
}
describe('stable controller execution', () => {
  it.each([nativeUUIDs.ios, -1])(
    'refuses echoed5 lease ID %s before PUT/finalize and leaves a parseable checkpoint',
    async (updateId) => {
      const { options, root, live } = fixture();
      live.splice(0);
      options.state.active = null;
      const candidate = candidateFixture();
      const expoConfig = {
        updates: { requestHeaders: { 'expo-app-id': desiredOtaState.appId, 'expo-channel-name': 'production' } },
      };
      for (const platform of ['ios', 'android'] as const) {
        const bundlePath = `_expo/static/js/${platform}/main.hbc`;
        mkdirSync(join(root, platform, '_expo/static/js', platform), { recursive: true });
        const bundle = Buffer.from(`${platform}: frozen test export`);
        candidate.receipt.platforms[platform].bundleSha256 = createHash('sha256').update(bundle).digest('hex');
        writeFileSync(join(root, platform, bundlePath), bundle);
        writeFileSync(
          join(root, platform, 'metadata.json'),
          JSON.stringify({
            version: 0,
            bundler: 'metro',
            fileMetadata: { [platform]: { bundle: bundlePath, assets: [] } },
          }),
        );
        writeFileSync(join(root, platform, 'expoConfig.json'), JSON.stringify(expoConfig));
      }
      options.state.candidate = candidate;
      options.now = new Date('2026-10-08T22:00:00Z');
      writeFileSync(join(root, 'candidate.json'), JSON.stringify(candidate));
      const statePath = join(root, 'state.json');
      options.save = () => saveState(statePath, options.state, '201');
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
        const platform = (url.searchParams.get('platform') ?? new Headers(init.headers).get('expo-platform')) as
          | 'ios'
          | 'android';
        if (url.pathname === '/manifest')
          return Response.json({
            id: candidate.receipt.baselineProductionUpdateIds[platform],
            runtimeVersion: candidate.receipt.platforms[platform].runtimeVersion,
            launchAsset: {
              hash: Buffer.from(candidate.receipt.platforms[platform].bundleSha256, 'hex').toString('base64url'),
            },
            assets: [],
            extra: { branch: 'production', expoClient: expoConfig },
          });
        if (url.pathname.includes('/requestUploadUrl/'))
          return Response.json({
            updateId,
            rolloutPercentage: 5,
            uploadRequests: [
              {
                requestUploadUrl: `https://bucket.test/${platform}`,
                fileName: 'main.hbc',
                filePath: `_expo/static/js/${platform}/main.hbc`,
              },
            ],
          });
        throw new Error(`Unexpected request ${init.method ?? 'GET'} ${url.pathname}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      const actual = await vi.importActual<typeof import('./mobile-ota-promote.ts')>('./mobile-ota-promote.ts');
      mocks.promote.mockImplementationOnce(actual.promoteArchivedOta);
      await expect(tickStable(options)).rejects.toThrow(typeof updateId === 'number' ? 'numeric id' : 'valid updateId');
      expect(readState(statePath).active).toMatchObject({ phase: 'starting', updateIds: {}, unchangedPlatforms: {} });
      expect(options.state.active).toMatchObject({ updateIds: {} });
      expect(JSON.parse(readFileSync(join(root, 'rollout-receipt.json'), 'utf8')).updateIds).toEqual({});
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            init?.method === 'PUT' ||
            (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).includes(
              '/markUpdateAsUploaded/',
            ),
        ),
      ).toBe(false);
      await abortStable(options);
      expect(options.state.active).toBeNull();
    },
  );

  it('refuses malformed callback and finally receipt ownership without mutating the active checkpoint', async () => {
    const { options, root, live } = fixture();
    live.splice(0);
    options.state.active = null;
    options.state.candidate = candidateFixture();
    options.now = new Date('2026-10-08T22:00:00Z');
    writeFileSync(join(root, 'candidate.json'), JSON.stringify(candidateFixture()));
    const path = join(root, 'state.json');
    options.save = () => saveState(path, options.state, '201');
    mocks.promote.mockImplementationOnce(
      async (input: Parameters<typeof import('./mobile-ota-promote').promoteArchivedOta>[0]) => {
        const malformed = {
          updateIds: { ios: nativeUUIDs.ios },
          unchangedPlatforms: {},
          baselineUpdateIds: candidateFixture().receipt.baselineProductionUpdateIds,
        };
        writePromotionRecord(input.rollout!.receiptPath, malformed);
        input.rollout!.onRecord!(malformed);
        throw new Error('Must never reach simulated upload');
      },
    );
    await expect(tickStable(options)).rejects.toThrow('numeric id');
    expect(readState(path).active?.updateIds).toEqual({});
    expect(options.state.active).toMatchObject({ updateIds: {} });
  });
  it('atomically checkpoints each promotion record before simulated uploads/finalize', async () => {
    const { options, root, live } = fixture();
    live.splice(0);
    options.state.active = null;
    options.state.candidate = candidateFixture();
    options.now = new Date('2026-10-08T22:00:00Z');
    writeFileSync(join(root, 'candidate.json'), JSON.stringify(candidateFixture()));
    const path = join(root, 'state.json');
    options.save = () => saveState(path, options.state, '201');
    mocks.promote.mockImplementationOnce(
      async (input: Parameters<typeof import('./mobile-ota-promote').promoteArchivedOta>[0]) => {
        const record = {
          updateIds: {},
          unchangedPlatforms: { android: candidateFixture().receipt.baselineProductionUpdateIds.android! },
          baselineUpdateIds: candidateFixture().receipt.baselineProductionUpdateIds,
        };
        input.rollout!.onRecord!(record);
        expect(readState(path).active).toMatchObject({
          phase: 'starting',
          updateIds: {},
          unchangedPlatforms: record.unchangedPlatforms,
        });
        const leased = { ...record, updateIds: { ios: '31' } };
        input.rollout!.onRecord!(leased);
        expect(readState(path).active).toMatchObject({
          phase: 'starting',
          updateIds: { ios: '31' },
          unchangedPlatforms: record.unchangedPlatforms,
        });
        // Simulate a process failure after bytes could have been uploaded.
        writePromotionRecord(input.rollout!.receiptPath, leased);
        throw new Error('Interrupted finalize');
      },
    );
    await expect(tickStable(options)).rejects.toThrow('Interrupted finalize');
    expect(readState(path).active).toMatchObject({
      phase: 'starting',
      updateIds: { ios: '31' },
      unchangedPlatforms: { android: candidateFixture().receipt.baselineProductionUpdateIds.android },
    });
  });

  it('recovers a trusted live lease before ownership classification and can resume the mixed release', async () => {
    const { options, root, live } = fixture();
    options.state.active!.phase = 'starting';
    options.state.active!.updateIds = {};
    live.splice(1, 1);
    const candidate = options.state.active!.candidate;
    writeFileSync(join(root, 'candidate.json'), JSON.stringify(candidate));
    writeFileSync(
      join(root, 'rollout-receipt.json'),
      JSON.stringify({
        branch: 'production',
        commitHash: candidate.receipt.commitHash,
        updateIds: { ios: '31' },
        unchangedPlatforms: { android: candidate.receipt.baselineProductionUpdateIds.android },
        baselineUpdateIds: candidate.receipt.baselineProductionUpdateIds,
      }),
    );
    await tickStable(options);
    expect(options.state.active).toMatchObject({
      phase: 'ramping',
      updateIds: { ios: '31' },
      unchangedPlatforms: { android: candidate.receipt.baselineProductionUpdateIds.android },
    });
  });

  it('aborts a recovered pending lease without downloading or reading an expired archive', async () => {
    const { options, root, live, client } = fixture();
    live.splice(0);
    options.state.active!.phase = 'starting';
    options.state.active!.updateIds = {};
    const candidate = options.state.active!.candidate;
    writeFileSync(
      join(root, 'rollout-receipt.json'),
      JSON.stringify({
        branch: 'production',
        commitHash: candidate.receipt.commitHash,
        updateIds: { ios: '31' },
        unchangedPlatforms: { android: candidate.receipt.baselineProductionUpdateIds.android },
        baselineUpdateIds: candidate.receipt.baselineProductionUpdateIds,
      }),
    );
    mocks.unchanged.mockRejectedValue(new Error('Expired archive'));
    await abortStable(options);
    expect(options.state.active).toBeNull();
    expect(client.revertUpdateRollout).not.toHaveBeenCalled();
    expect(mocks.unchanged).not.toHaveBeenCalled();
  });
  it('handles both unchanged platforms without health, percentage, or revert writes', async () => {
    const { options, root, live, client } = fixture();
    live.splice(0);
    options.state.active = null;
    options.state.candidate = candidateFixture();
    options.now = new Date('2026-10-08T22:00:00Z');
    writeFileSync(join(root, 'candidate.json'), JSON.stringify(candidateFixture()));
    mocks.promote.mockImplementationOnce(async (input: { rollout: { receiptPath: string } }) => {
      writePromotionRecord(input.rollout.receiptPath, {
        updateIds: {},
        unchangedPlatforms: candidateFixture().receipt.baselineProductionUpdateIds,
      });
    });
    await tickStable(options);
    expect(options.state.active).toBeNull();
    expect(options.state.lastCompletedCommit).toBe(candidateFixture().receipt.commitHash);
    expect(options.state.lastStartedDate).toBe('2026-10-08');
    expect(client.getUpdateHealth).not.toHaveBeenCalled();
    expect(client.setUpdateRolloutPercentage).not.toHaveBeenCalled();
    expect(client.revertUpdateRollout).not.toHaveBeenCalled();
  });

  it('recovers attestations newer than a starting checkpoint and preserves a newer waiting candidate', async () => {
    const { options, root, live, client } = fixture();
    live.splice(0);
    options.state.active!.phase = 'starting';
    options.state.active!.updateIds = {};
    const activeCandidate = options.state.active!.candidate;
    const newer = { ...candidateFixture(), receipt: { ...candidateFixture().receipt, commitHash: 'f'.repeat(40) } };
    options.state.candidate = newer;
    writeFileSync(join(root, 'candidate.json'), JSON.stringify(activeCandidate));
    writeFileSync(
      join(root, 'rollout-receipt.json'),
      JSON.stringify({
        branch: 'production',
        commitHash: activeCandidate.receipt.commitHash,
        updateIds: {},
        baselineUpdateIds: activeCandidate.receipt.baselineProductionUpdateIds,
        unchangedPlatforms: activeCandidate.receipt.baselineProductionUpdateIds,
      }),
    );
    mocks.promote.mockImplementationOnce(async (input: { rollout: { receiptPath: string } }) => {
      expect(JSON.parse(readFileSync(input.rollout.receiptPath, 'utf8')).unchangedPlatforms).toEqual(
        activeCandidate.receipt.baselineProductionUpdateIds,
      );
    });
    await tickStable(options);
    expect(options.state.active).toBeNull();
    expect(options.state.candidate).toEqual(newer);
    expect(options.state.lastCompletedCommit).toBe(activeCandidate.receipt.commitHash);
    expect(client.setUpdateRolloutPercentage).not.toHaveBeenCalled();
    expect(mocks.unchanged).toHaveBeenCalledWith(
      expect.objectContaining({ unchangedPlatforms: activeCandidate.receipt.baselineProductionUpdateIds }),
    );
  });

  it.each(['ios', 'android'] as const)('starts and recovers a mixed candidate with %s unchanged', async (unchanged) => {
    const { options, root, live } = fixture();
    const changed = unchanged === 'ios' ? 'android' : 'ios';
    const id = changed === 'ios' ? '31' : '32';
    live.splice(0);
    options.state.active = null;
    options.state.candidate = candidateFixture();
    options.now = new Date('2026-10-08T22:00:00Z');
    writeFileSync(join(root, 'candidate.json'), JSON.stringify(candidateFixture()));
    mocks.promote.mockImplementationOnce(async (input: { rollout: { receiptPath: string } }) => {
      writePromotionRecord(input.rollout.receiptPath, {
        updateIds: { [changed]: id },
        unchangedPlatforms: { [unchanged]: candidateFixture().receipt.baselineProductionUpdateIds[unchanged] },
      });
    });
    await tickStable(options);
    expect(options.state.active).toMatchObject({
      phase: 'ramping',
      updateIds: { [changed]: id },
      unchangedPlatforms: { [unchanged]: candidateFixture().receipt.baselineProductionUpdateIds[unchanged] },
      completedPlatforms: {},
    });
    const path = join(root, 'state.json');
    saveState(path, options.state, '201');
    expect(readState(path).active).toEqual(options.state.active);
  });

  it.each(['ios', 'android'] as const)(
    'ramps, finishes, and refreshes baselines without mutating the unchanged %s head',
    async (unchanged) => {
      const { options, live, client } = fixture();
      const changed = unchanged === 'ios' ? 'android' : 'ios';
      const active = options.state.active!;
      delete active.updateIds[unchanged];
      active.unchangedPlatforms = { [unchanged]: active.candidate.receipt.baselineProductionUpdateIds[unchanged]! };
      live.splice(
        live.findIndex((entry) => entry.platform === unchanged),
        1,
      );
      const changedId = active.updateIds[changed]!;
      await tickStable(options);
      expect(client.setUpdateRolloutPercentage).toHaveBeenLastCalledWith(
        'production',
        active.candidate.receipt.platforms[changed].runtimeVersion,
        10,
        changedId,
      );
      expect(client.getUpdateHealth.mock.calls.flat(2)).not.toContain(active.unchangedPlatforms[unchanged]);
      options.state.candidate = {
        ...candidateFixture(),
        receipt: { ...candidateFixture().receipt, commitHash: 'f'.repeat(40) },
      };
      active.percentage = 50;
      active.stepSince = '2026-10-09T10:00:00Z';
      live[0].percentage = 50;
      options.now = new Date('2026-10-09T22:00:00Z');
      await tickStable(options);
      expect(options.state.active).toBeNull();
      expect(client.setUpdateRolloutPercentage).toHaveBeenCalledTimes(2);
      expect(client.setUpdateRolloutPercentage).toHaveBeenLastCalledWith(
        'production',
        active.candidate.receipt.platforms[changed].runtimeVersion,
        100,
        changedId,
      );
      expect(options.state.candidate?.receipt.baselineProductionUpdateIds).toEqual({
        [unchanged]: active.unchangedPlatforms[unchanged],
        [changed]: nativeUUIDs[changed],
      });
    },
  );

  it.each(['ios', 'android'] as const)(
    'preserves an external %s replacement and aborts only the changed sibling without archive reads',
    async (unchanged) => {
      const { options, live, client, baselineIds } = fixture();
      const changed = unchanged === 'ios' ? 'android' : 'ios';
      const active = options.state.active!;
      delete active.updateIds[unchanged];
      active.unchangedPlatforms = { [unchanged]: active.candidate.receipt.baselineProductionUpdateIds[unchanged]! };
      live.splice(
        live.findIndex((entry) => entry.platform === unchanged),
        1,
      );
      const external = '77777777-7777-7777-7777-777777777777';
      baselineIds[unchanged] = external;
      mocks.unchanged.mockRejectedValue(new Error('Expired ZIP must not be read'));
      await tickStable(options);
      expect(options.state.active).toBeNull();
      expect(baselineIds[unchanged]).toBe(external);
      expect(client.revertUpdateRollout).toHaveBeenCalledOnce();
      expect(client.revertUpdateRollout).toHaveBeenCalledWith(
        'production',
        active.candidate.receipt.platforms[changed].runtimeVersion,
        active.updateIds[changed],
      );
      expect(mocks.unchanged).not.toHaveBeenCalled();
    },
  );

  it('holds on absent changed-platform health without inventing an unchanged cohort', async () => {
    const { options, live, client } = fixture();
    options.state.active!.unchangedPlatforms = { ios: candidateFixture().receipt.baselineProductionUpdateIds.ios! };
    delete options.state.active!.updateIds.ios;
    live.splice(0, 1);
    client.getUpdateHealth.mockResolvedValue({});
    await tickStable(options);
    expect(options.state.active?.percentage).toBe(5);
    expect(client.setUpdateRolloutPercentage).not.toHaveBeenCalled();
  });

  it('refuses unchanged byte/config drift before any ramp write', async () => {
    const { options, live, client } = fixture();
    options.state.active!.unchangedPlatforms = { ios: candidateFixture().receipt.baselineProductionUpdateIds.ios! };
    delete options.state.active!.updateIds.ios;
    live.splice(0, 1);
    mocks.unchanged.mockRejectedValue(new Error('production asset hashes differ from stage'));
    await expect(tickStable(options)).rejects.toThrow('asset hashes differ');
    expect(client.setUpdateRolloutPercentage).not.toHaveBeenCalled();
    expect(client.getUpdateHealth).not.toHaveBeenCalled();
  });
  it('rechecks unchanged bytes after reading health, immediately before the ramp write', async () => {
    const { options, live, client } = fixture();
    options.state.active!.unchangedPlatforms = { ios: candidateFixture().receipt.baselineProductionUpdateIds.ios! };
    delete options.state.active!.updateIds.ios;
    live.splice(0, 1);
    mocks.unchanged
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('unchanged baseline UUID differs from stage'));
    await expect(tickStable(options)).rejects.toThrow('unchanged baseline UUID differs');
    expect(client.getUpdateHealth).toHaveBeenCalled();
    expect(client.setUpdateRolloutPercentage).not.toHaveBeenCalled();
  });

  it('reverts only the changed canary when its actual cohort is unhealthy', async () => {
    const { options, live, client, baselineIds } = fixture();
    const active = options.state.active!;
    active.unchangedPlatforms = { ios: active.candidate.receipt.baselineProductionUpdateIds.ios! };
    delete active.updateIds.ios;
    live.splice(0, 1);
    client.getUpdateHealth.mockImplementation(async (ids) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          {
            devicesOnUpdate: 20,
            successfulDevices: id === nativeUUIDs.android ? 0 : 20,
            faultyDevices: id === nativeUUIDs.android ? 20 : 0,
          },
        ]),
      ),
    );
    await tickStable(options);
    expect(options.state.active).toBeNull();
    expect(client.revertUpdateRollout).toHaveBeenCalledOnce();
    expect(client.revertUpdateRollout).toHaveBeenCalledWith(
      'production',
      active.candidate.receipt.platforms.android.runtimeVersion,
      '32',
    );
    expect(client.setUpdateRolloutPercentage).not.toHaveBeenCalled();
    expect(baselineIds.ios).toBe(active.unchangedPlatforms.ios);
  });

  it('resumes an already-completed changed finish without writing to the unchanged platform', async () => {
    const { options, live, client, baselineIds } = fixture();
    const active = options.state.active!;
    active.phase = 'finishing';
    active.unchangedPlatforms = { ios: active.candidate.receipt.baselineProductionUpdateIds.ios! };
    delete active.updateIds.ios;
    live.splice(0);
    baselineIds.android = nativeUUIDs.android;
    await tickStable(options);
    expect(options.state.active).toBeNull();
    expect(options.state.lastCompletedCommit).toBe(active.candidate.receipt.commitHash);
    expect(client.setUpdateRolloutPercentage).not.toHaveBeenCalled();
    expect(client.revertUpdateRollout).not.toHaveBeenCalled();
    expect(client.getUpdateHealth.mock.calls.flat(2)).not.toContain(active.unchangedPlatforms.ios);
  });
  it('starts archived bytes, saves leased IDs and starts clocks after confirmations', async () => {
    const { options, root, live } = fixture();
    live.splice(0);
    options.state.active = null;
    options.state.candidate = candidateFixture();
    options.now = new Date('2026-10-08T22:00:00Z');
    options.clock = () => new Date('2026-10-08T22:30:00Z');
    writeFileSync(join(root, 'candidate.json'), JSON.stringify(candidateFixture()));
    mocks.promote.mockImplementationOnce(async (input: { rollout: { receiptPath: string } }) => {
      writePromotionRecord(input.rollout.receiptPath, { updateIds: { ios: '31', android: '32' } });
    });
    await tickStable(options);
    expect(options.state.active).toMatchObject({
      phase: 'ramping',
      updateIds: { ios: '31', android: '32' },
      startedAt: '2026-10-08T22:30:00.000Z',
      stepSince: '2026-10-08T22:30:00.000Z',
    });
    expect(mocks.promote).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'production',
        iosExport: join(root, 'ios'),
        androidExport: join(root, 'android'),
      }),
    );
    const path = join(root, 'state.json');
    saveState(path, options.state, '201');
    expect(readState(path).active?.updateIds).toEqual({ ios: '31', android: '32' });
  });
  it('failed starts retain partial leases and can be explicitly aborted', async () => {
    const { options, root, live } = fixture();
    live.splice(0);
    options.state.active = null;
    options.state.candidate = candidateFixture();
    options.now = new Date('2026-10-08T22:00:00Z');
    writeFileSync(join(root, 'candidate.json'), JSON.stringify(candidateFixture()));
    mocks.promote.mockImplementationOnce(async (input: { rollout: { receiptPath: string } }) => {
      writePromotionRecord(input.rollout.receiptPath, { updateIds: { ios: '31' } });
      throw new Error('Second lease unavailable');
    });
    await expect(tickStable(options)).rejects.toThrow('Second lease unavailable');
    expect(options.state.active).toMatchObject({ phase: 'starting', updateIds: { ios: '31' } });
    const path = join(root, 'state.json');
    saveState(path, options.state, '201');
    expect(readState(path).active?.updateIds).toEqual({ ios: '31' });
    options.save = () => saveState(path, options.state, '202');
    await abortStable(options);
    expect(options.state.active).toBeNull();
    expect(readState(path).active).toBeNull();
  });
  it('full finish refreshes only the baseline the owned release replaced', async () => {
    const { options, live } = fixture();
    options.now = new Date('2026-10-09T22:00:00Z');
    options.state.active!.percentage = 50;
    options.state.active!.stepSince = '2026-10-09T10:00:00Z';
    live.forEach((entry) => {
      entry.percentage = 50;
    });
    options.state.candidate = {
      ...candidateFixture(),
      receipt: { ...candidateFixture().receipt, commitHash: 'f'.repeat(40) },
    };
    await tickStable(options);
    expect(options.state.active).toBeNull();
    expect(options.state.lastCompletedCommit).toBe(candidateFixture().receipt.commitHash);
    expect(options.state.candidate?.receipt.baselineProductionUpdateIds).toEqual(nativeUUIDs);
  });
  it('hotfix interruption preserves its head and reverts only the remaining owned platform', async () => {
    const { options, live, baselineIds, client } = fixture();
    live.splice(0, 1);
    baselineIds.ios = '77777777-7777-7777-7777-777777777777';
    await tickStable(options);
    expect(options.state.active).toBeNull();
    expect(client.revertUpdateRollout).toHaveBeenCalledTimes(1);
    expect(client.revertUpdateRollout.mock.calls[0][2]).toBe('32');
    expect(baselineIds.ios).toBe('77777777-7777-7777-7777-777777777777');
  });
  it('abort refuses a completed platform still serving the partially finished candidate', async () => {
    const { options, live, baselineIds, client } = fixture();
    live.splice(0, 1);
    options.state.active!.phase = 'finishing';
    baselineIds.ios = nativeUUIDs.ios;
    await expect(abortStable(options)).rejects.toThrow('Restore the completed ios');
    expect(client.revertUpdateRollout).not.toHaveBeenCalled();
    expect(options.state.active?.phase).toBe('finishing');
  });
  it('planning observes but never writes or saves', async () => {
    const { options, client, save } = fixture();
    options.apply = false;
    await tickStable(options);
    expect(client.setUpdateRolloutPercentage).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(mocks.promote).not.toHaveBeenCalled();
  });
  it('rejects an unowned rollout on any runtime', async () => {
    const { options, live, client } = fixture();
    live[0].updateId = '999';
    await expect(tickStable(options)).rejects.toThrow('Unowned rollout');
    expect(client.setUpdateRolloutPercentage).not.toHaveBeenCalled();
  });
  it('does not write with missing health even at a due step', async () => {
    const { options, client } = fixture();
    client.getUpdateHealth.mockResolvedValue({});
    await tickStable(options);
    expect(client.setUpdateRolloutPercentage).not.toHaveBeenCalled();
  });
  it('step clocks start after both slow writes and never leapfrog', async () => {
    const { options, client } = fixture();
    options.clock = () => new Date('2026-10-09T03:30:00Z');
    await tickStable(options);
    expect(options.state.active?.percentage).toBe(10);
    expect(options.state.active?.stepSince).toBe('2026-10-09T03:30:00.000Z');
    options.now = new Date('2026-10-09T07:29:59Z');
    await tickStable(options);
    expect(client.setUpdateRolloutPercentage).toHaveBeenCalledTimes(2);
  });
  it('partial raise resumes exactly the intended step, then resets the full timer', async () => {
    const { options, client, live } = fixture();
    const write = client.setUpdateRolloutPercentage.getMockImplementation()!;
    client.setUpdateRolloutPercentage
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(new Error('Android write unavailable'));
    await expect(tickStable(options)).rejects.toThrow('Android write unavailable');
    expect(live[0].percentage).toBe(10);
    expect(options.state.active?.pendingPercentage).toBe(10);
    options.now = new Date('2026-10-09T02:30:00Z');
    options.clock = () => options.now;
    await tickStable(options);
    expect(options.state.active?.percentage).toBe(10);
    expect(options.state.active?.pendingPercentage).toBeNull();
    expect(options.state.active?.stepSince).toBe('2026-10-09T02:30:00.000Z');
  });
  it('unhealthy on either platform reverts both recorded IDs', async () => {
    const { options, client } = fixture();
    client.getUpdateHealth.mockImplementation(async (ids) =>
      Object.fromEntries(ids.map((id) => [id, { devicesOnUpdate: 10, successfulDevices: 0, faultyDevices: 10 }])),
    );
    await tickStable(options);
    expect(client.revertUpdateRollout).toHaveBeenCalledTimes(2);
    expect(options.state.active).toBeNull();
    expect(options.state.rejectedCommit).toBe(candidateFixture().receipt.commitHash);
  });
  it('unhealthy after a partial raise clears its pending step before persisting and reverting', async () => {
    const { options, client, root, live } = fixture();
    options.state.active!.pendingPercentage = 10;
    live[0].percentage = 10;
    options.save = () => saveState(join(root, 'state.json'), options.state, '201');
    client.getUpdateHealth.mockImplementation(async (ids) =>
      Object.fromEntries(ids.map((id) => [id, { devicesOnUpdate: 10, successfulDevices: 0, faultyDevices: 10 }])),
    );
    await tickStable(options);
    expect(client.revertUpdateRollout).toHaveBeenCalledTimes(2);
    expect(readState(join(root, 'state.json')).active).toBeNull();
  });
  it('partial revert persists completion and refuses a subsequent external hotfix', async () => {
    const { options, client, baselineIds } = fixture();
    options.state.active!.phase = 'reverting';
    const write = client.revertUpdateRollout.getMockImplementation()!;
    client.revertUpdateRollout.mockImplementationOnce(write).mockRejectedValueOnce(new Error('Android unavailable'));
    await expect(tickStable(options)).rejects.toThrow('Android unavailable');
    expect(options.state.active?.completedPlatforms.ios).toBe(baselineIds.ios);
    baselineIds.ios = '77777777-7777-7777-7777-777777777777';
    await expect(tickStable(options)).rejects.toThrow('completed head changed');
    expect(client.revertUpdateRollout).toHaveBeenCalledTimes(2);
  });
  it('partial finish refuses the other platform after a completed head changes', async () => {
    const { options, client, live, baselineIds } = fixture();
    options.now = new Date('2026-10-09T22:00:00Z');
    options.state.active!.percentage = 50;
    options.state.active!.stepSince = '2026-10-09T10:00:00Z';
    live.forEach((entry) => {
      entry.percentage = 50;
    });
    const write = client.setUpdateRolloutPercentage.getMockImplementation()!;
    client.setUpdateRolloutPercentage
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(new Error('Android unavailable'));
    await expect(tickStable(options)).rejects.toThrow('Android unavailable');
    expect(options.state.active?.phase).toBe('finishing');
    expect(options.state.active?.completedPlatforms.ios).toBe(nativeUUIDs.ios);
    baselineIds.ios = '77777777-7777-7777-7777-777777777777';
    await expect(tickStable(options)).rejects.toThrow('owned rollout disappeared');
    expect(client.setUpdateRolloutPercentage).toHaveBeenCalledTimes(2);
  });
  it('stale production invalidates a prepared candidate before active state or a lease', async () => {
    const { options, baselineIds } = fixture();
    options.state.active = null;
    options.state.candidate = candidateFixture();
    options.now = new Date('2026-10-08T22:00:00Z');
    baselineIds.ios = nativeUUIDs.ios;
    options.client.getUpdateRollout = vi.fn(async () => ({ active: false, updates: [] }));
    writeFileSync(join(options.stagePath, 'candidate.json'), JSON.stringify(candidateFixture()));
    await tickStable(options);
    expect(mocks.promote).not.toHaveBeenCalled();
    expect(options.state.active).toBeNull();
    expect(options.state.candidate).toBeNull();
    expect(options.state.rejectedCommit).toBe(candidateFixture().receipt.commitHash);
  });
});
describe('checkpoint file and command safety', () => {
  function invokeWithoutAdmin(
    path: string,
    root: string,
    overrides: { ref?: string; attempt?: string; loadedProducer?: string; apply?: boolean } = {},
  ) {
    return spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        fileURLToPath(new URL('./mobile-ota-stable.ts', import.meta.url)),
        'tick',
        ...(overrides.apply === false ? [] : ['--apply']),
        '--state',
        path,
        '--stage',
        root,
        '--loaded-state-run-id',
        overrides.loadedProducer ?? '201',
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          GITHUB_REF: overrides.ref ?? 'refs/heads/main',
          GITHUB_RUN_ATTEMPT: overrides.attempt ?? '1',
          GITHUB_RUN_ID: '202',
          OTA_ADMIN_EMAIL: '',
          OTA_ADMIN_PASSWORD: '',
        },
      },
    );
  }
  it('retains validated ownership under the new run producer when admin initialization fails', () => {
    const { root, options } = fixture();
    options.state.candidate = candidateFixture();
    options.state.candidate.receipt.commitHash = 'f'.repeat(40);
    const path = join(root, 'state.json');
    saveState(path, options.state, '201');
    const execution = invokeWithoutAdmin(path, root);
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain('Set OTA_ADMIN_EMAIL and OTA_ADMIN_PASSWORD');
    const retained = readState(path);
    expect(retained.checkpointRunId).toBe('202');
    expect(retained.active).toEqual(options.state.active);
    expect(retained.candidate).toEqual(options.state.candidate);
  });
  it.each([
    { overrides: { ref: 'refs/heads/other' }, error: 'Only trusted main can apply' },
    { overrides: { loadedProducer: '199' }, error: 'Checkpoint producer differs' },
    { overrides: { attempt: '2' }, error: 'Dispatch a new controller run' },
    { overrides: { apply: false }, error: 'Set OTA_ADMIN_EMAIL and OTA_ADMIN_PASSWORD' },
  ])('does not relabel a refused or read-only checkpoint: $error', ({ overrides, error }) => {
    const { root, options } = fixture();
    const path = join(root, 'state.json');
    saveState(path, options.state, '201');
    const original = readFileSync(path, 'utf8');
    const execution = invokeWithoutAdmin(path, root, overrides);
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain(error);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
  it('requires explicit apply and rejects unknown/repeated flags', () => {
    expect(parseStableArgs(['tick', '--state', 'state.json', '--stage', 'stage']).apply).toBe(false);
    expect(() => parseStableArgs(['tick', '--state', 'state.json', '--stage', 'stage', '--force'])).toThrow();
    expect(() => parseStableArgs(['tick', '--state', 'one', '--state', 'two', '--stage', 'stage'])).toThrow();
  });
  it('atomically round-trips a validated checkpoint and rejects corrupt files', () => {
    const { root } = fixture();
    const path = join(root, 'state.json');
    const state = initialStableState();
    saveState(path, state, '201');
    expect(readState(path).checkpointRunId).toBe('201');
    writeFileSync(path, '{broken');
    expect(() => readState(path)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });
});
