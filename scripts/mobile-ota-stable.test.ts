import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialStableState } from './lib/ota-stable';
import { tickStable, abortStable, parseStableArgs, saveState, readState } from './mobile-ota-stable';
import type { XpremAdminClient } from './lib/xprem-admin.mts';
import { activeFixture, candidateFixture } from './__tests__/helpers/ota-stable-fixtures';

const mocks = vi.hoisted(() => ({ baseline: vi.fn(), promote: vi.fn(), validate: vi.fn() }));
vi.mock('./mobile-ota-promote.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-ota-promote.ts')>()),
  captureProductionBaseline: mocks.baseline,
  promoteArchivedOta: mocks.promote,
  validateExport: mocks.validate,
}));

const nativeUUIDs = { ios: '33333333-3333-3333-3333-333333333333', android: '44444444-4444-4444-4444-444444444444' };
const tempPaths: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.promote.mockResolvedValue(undefined);
  mocks.baseline.mockResolvedValue(candidateFixture().receipt.baselineProductionUpdateIds);
});
afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});
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
  it('starts archived bytes, saves leased IDs and starts clocks after confirmations', async () => {
    const { options, root, live } = fixture();
    live.splice(0);
    options.state.active = null;
    options.state.candidate = candidateFixture();
    options.now = new Date('2026-10-08T22:00:00Z');
    options.clock = () => new Date('2026-10-08T22:30:00Z');
    writeFileSync(join(root, 'candidate.json'), JSON.stringify(candidateFixture()));
    mocks.promote.mockImplementationOnce(async (input: { rollout: { receiptPath: string } }) => {
      writeFileSync(input.rollout.receiptPath, JSON.stringify({ updateIds: { ios: '31', android: '32' } }));
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
      writeFileSync(input.rollout.receiptPath, JSON.stringify({ updateIds: { ios: '31' } }));
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
