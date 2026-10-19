import { describe, expect, it, vi } from 'vitest';
import { unlockStagedControls } from './mobile-ota-unlock-staged';
import type { OtaPlatform } from './lib/ota-publish-protocol';
import type { ControlHead } from './lib/ota-unlock-receipt';
import type { XpremRolloutUpdate } from './lib/xprem-admin.mts';
import { restoredIds, unlockExpected, unlockProof } from './__tests__/helpers/ota-unlock-fixtures';
import { callerLeaseFixture } from './__tests__/helpers/ota-unlock-lease-fixtures';
import { protectUnlockWrites } from './lib/ota-unlock-lease.mjs';

function fixture(active: OtaPlatform[] = ['ios', 'android'], sharedRuntime = false) {
  const expected = structuredClone(unlockExpected);
  if (sharedRuntime) expected.runtimes.android = expected.runtimes.ios;
  const heads: Record<OtaPlatform, ControlHead> = {
    ios: { updateId: expected.baselines.ios, contentSha256: 'a'.repeat(64) },
    android: { updateId: expected.baselines.android, contentSha256: 'b'.repeat(64) },
  };
  const rollouts: Record<OtaPlatform, XpremRolloutUpdate | null> = {
    ios: active.includes('ios')
      ? { updateId: 11, controlUpdateId: 10, platform: 'ios', percentage: 50, createdAt: null }
      : null,
    android: active.includes('android')
      ? { updateId: 21, controlUpdateId: 20, platform: 'android', percentage: 50, createdAt: null }
      : null,
  };
  const client = {
    getUpdateRollout: vi.fn(async (_branch: string, runtime: string) => {
      const updates = (['ios', 'android'] as const).flatMap((platform) =>
        expected.runtimes[platform] === runtime && rollouts[platform] ? [structuredClone(rollouts[platform]!)] : [],
      );
      return { active: updates.length > 0, updates };
    }),
    getUpdateDetails: vi.fn(async (_branch: string, _runtime: string, identifier: string | number) => {
      const platform = String(identifier) === '10' ? 'ios' : 'android';
      return { updateId: identifier, updateUUID: expected.baselines[platform], platform, commitHash: null };
    }),
    revertUpdateRollout: vi.fn(async (_branch: string, runtime: string, identifier: string | number) => {
      for (const platform of ['ios', 'android'] as const) {
        if (
          rollouts[platform] &&
          expected.runtimes[platform] === runtime &&
          (sharedRuntime || String(rollouts[platform]!.updateId) === String(identifier))
        ) {
          rollouts[platform] = null;
          heads[platform].updateId = restoredIds[platform];
        }
      }
    }),
  };
  const readHead = vi.fn(async (platform: OtaPlatform) => ({ ...heads[platform] }));
  const run = (verificationDelaysMs: readonly number[] = []) =>
    unlockStagedControls({ ...expected, proof: unlockProof, client, readHead, verificationDelaysMs });
  return { expected, heads, rollouts, client, readHead, run };
}

describe('staged control unlock', () => {
  it.each(['step-ended', 'expired'])('blocks the second staged write when caller %s', async (failure) => {
    const staged = fixture();
    const lifetime = callerLeaseFixture();
    const revert = staged.client.revertUpdateRollout.getMockImplementation()!;
    staged.client.revertUpdateRollout.mockImplementation(async (...args) => {
      await revert(...args);
      if (failure === 'expired') lifetime.clock.nowMs = lifetime.lease.expiresAtMs;
      else lifetime.job.steps[0].status = 'completed';
    });
    await expect(
      unlockStagedControls({
        ...staged.expected,
        proof: unlockProof,
        readHead: staged.readHead,
        client: protectUnlockWrites(staged.client, lifetime.guard),
        verificationDelaysMs: [],
      }),
    ).rejects.toThrow(/wait step|expired/);
    expect(staged.client.revertUpdateRollout).toHaveBeenCalledTimes(1);
    expect(staged.rollouts.android).not.toBeNull();
  });
  it.each([{ selected: ['ios', 'android'] }, { selected: ['ios'] }, { selected: [] }] as { selected: OtaPlatform[] }[])(
    'attests exactly the requested controls with live platforms $selected',
    async ({ selected }) => {
      const { run, client } = fixture(selected);
      const receipt = await run();
      expect(client.revertUpdateRollout).toHaveBeenCalledTimes(selected.length);
      for (const platform of ['ios', 'android'] as const) {
        expect(receipt.platforms[platform]).toMatchObject({
          originalUpdateId: unlockExpected.baselines[platform],
          restoredUpdateId: selected.includes(platform) ? restoredIds[platform] : unlockExpected.baselines[platform],
          mode: selected.includes(platform) ? 'reverted' : 'unchanged',
        });
      }
    },
  );

  it('validates the second platform before reverting the first', async () => {
    const { run, heads, client } = fixture();
    heads.android.updateId = restoredIds.android;
    await expect(run()).rejects.toThrow('baseline changed before unlock');
    expect(client.revertUpdateRollout).not.toHaveBeenCalled();
  });
  it('rejects a control UUID differing from the stage before any write', async () => {
    const { run, client } = fixture();
    client.getUpdateDetails.mockResolvedValue({
      updateId: 10,
      updateUUID: restoredIds.ios,
      platform: 'ios',
      commitHash: null,
    });
    await expect(run()).rejects.toThrow('does not replace the staged baseline');
    expect(client.revertUpdateRollout).not.toHaveBeenCalled();
  });
  it('cannot revert a live rollout under an empty saved baseline', async () => {
    const { expected, heads, client, readHead } = fixture();
    expected.baselines.ios = null;
    heads.ios = { updateId: null, contentSha256: null };
    await expect(unlockStagedControls({ ...expected, proof: unlockProof, client, readHead })).rejects.toThrow(
      'no control update',
    );
    expect(client.revertUpdateRollout).not.toHaveBeenCalled();
  });
  it('keeps an empty baseline unchanged when no rollout exists', async () => {
    const { expected, heads, client, readHead } = fixture([]);
    expected.baselines.ios = null;
    heads.ios = { updateId: null, contentSha256: null };
    const receipt = await unlockStagedControls({ ...expected, proof: unlockProof, client, readHead });
    expect(receipt.platforms.ios).toMatchObject({ originalUpdateId: null, restoredUpdateId: null, mode: 'unchanged' });
    expect(client.revertUpdateRollout).not.toHaveBeenCalled();
  });
  it('refuses a disappeared rollout before this job wrote anything', async () => {
    const { run, client, rollouts } = fixture();
    const inspect = client.getUpdateRollout.getMockImplementation()!;
    client.getUpdateRollout.mockImplementation(async (branch, runtime) => {
      if (client.getUpdateRollout.mock.calls.length === 3) rollouts.ios = null;
      return inspect(branch, runtime);
    });
    await expect(run()).rejects.toThrow('rollout changed during unlock');
    expect(client.revertUpdateRollout).not.toHaveBeenCalled();
  });
  it('re-reads expected rollout identity immediately before its protected write', async () => {
    const { run, client, rollouts } = fixture();
    const inspect = client.getUpdateRollout.getMockImplementation()!;
    client.getUpdateRollout.mockImplementation(async (branch, runtime) => {
      if (client.getUpdateRollout.mock.calls.length === 3) rollouts.ios!.updateId = 99;
      return inspect(branch, runtime);
    });
    await expect(run()).rejects.toThrow('rollout changed during unlock');
    expect(client.revertUpdateRollout).not.toHaveBeenCalled();
  });
  it('does not authorize an unrelated same-bytes update after a no-op', async () => {
    const { run, client, heads, readHead } = fixture([]);
    readHead.mockImplementation(async (platform) => ({
      ...heads[platform],
      ...(readHead.mock.calls.length > 2 && platform === 'ios' ? { updateId: restoredIds.ios } : {}),
    }));
    await expect(run()).rejects.toThrow('did not preserve the staged control');
    expect(client.revertUpdateRollout).not.toHaveBeenCalled();
  });
  it('returns no receipt after a partial revert failure', async () => {
    const { run, client } = fixture();
    const revert = client.revertUpdateRollout.getMockImplementation()!;
    client.revertUpdateRollout.mockImplementation(async (branch, runtime, identifier) => {
      if (runtime === unlockExpected.runtimes.android) throw new Error('second platform failed');
      return revert(branch, runtime, identifier);
    });
    await expect(run()).rejects.toThrow('second platform failed');
    expect(client.revertUpdateRollout).toHaveBeenCalledTimes(2);
  });
  it('requires restored control content to match even after a successful revert', async () => {
    const { run, heads, client } = fixture();
    const revert = client.revertUpdateRollout.getMockImplementation()!;
    client.revertUpdateRollout.mockImplementation(async (...args) => {
      await revert(...args);
      heads.ios.contentSha256 = 'f'.repeat(64);
    });
    await expect(run()).rejects.toThrow('did not preserve the staged control');
  });
  it('accounts for one shared-runtime revert restoring both platforms', async () => {
    const { run, client } = fixture(['ios', 'android'], true);
    const receipt = await run();
    expect(client.revertUpdateRollout).toHaveBeenCalledTimes(1);
    expect(receipt.platforms.android.restoredUpdateId).toBe(restoredIds.android);
  });
  it.each([false, true])('waits for both replacement UUIDs after revert, shared runtime=%s', async (sharedRuntime) => {
    const { run, client, heads, expected, readHead } = fixture(['ios', 'android'], sharedRuntime);
    const staleReads = { ios: 0, android: 0 };
    readHead.mockImplementation(async (platform) => {
      if (client.revertUpdateRollout.mock.calls.length > 0 && heads[platform].updateId === restoredIds[platform]) {
        if (staleReads[platform]++ === 0) return { ...heads[platform], updateId: expected.baselines[platform] };
      }
      return { ...heads[platform] };
    });
    const receipt = await run([0, 0]);
    expect(staleReads).toEqual({ ios: 2, android: 2 });
    expect(client.revertUpdateRollout).toHaveBeenCalledTimes(sharedRuntime ? 1 : 2);
    for (const platform of ['ios', 'android'] as const)
      expect(receipt.platforms[platform].restoredUpdateId).toBe(restoredIds[platform]);
  });
  it('shares the bounded propagation budget and returns no receipt on exhaustion', async () => {
    const { run, client, heads, expected, readHead } = fixture();
    const staleReads = { ios: 0, android: 0 };
    readHead.mockImplementation(async (platform) => {
      if (heads[platform].updateId === restoredIds[platform]) {
        if (platform === 'android' || staleReads.ios++ === 0) {
          staleReads.android += platform === 'android' ? 1 : 0;
          return { ...heads[platform], updateId: expected.baselines[platform] };
        }
      }
      return { ...heads[platform] };
    });
    await expect(run([0, 0])).rejects.toThrow('android restored control UUID did not become visible');
    expect(staleReads.android).toBe(2);
    expect(client.revertUpdateRollout).toHaveBeenCalledTimes(2);
  });
  it('refuses changed content during propagation without waiting it out', async () => {
    const { run, heads, readHead } = fixture();
    let staleReads = 0;
    readHead.mockImplementation(async (platform) => {
      if (platform === 'ios' && heads.ios.updateId === restoredIds.ios) {
        staleReads++;
        if (staleReads === 1) return { ...heads.ios, updateId: unlockExpected.baselines.ios };
        return { ...heads.ios, contentSha256: 'f'.repeat(64) };
      }
      return { ...heads[platform] };
    });
    await expect(run([0, 0])).rejects.toThrow('did not preserve the staged control');
    expect(staleReads).toBe(2);
  });
  it('refuses a rollout that appears while waiting for propagation', async () => {
    const { run, rollouts, heads, readHead } = fixture();
    let postRevertReads = 0;
    readHead.mockImplementation(async (platform) => {
      if (platform === 'ios' && heads.ios.updateId === restoredIds.ios && postRevertReads++ === 0) {
        rollouts.ios = { updateId: 99, controlUpdateId: 98, platform: 'ios', percentage: 10, createdAt: null };
        return { ...heads.ios, updateId: unlockExpected.baselines.ios };
      }
      return { ...heads[platform] };
    });
    await expect(run([0])).rejects.toThrow('rollout remains active after unlock');
  });
  it('refuses a missing head immediately after revert', async () => {
    const { run, heads, readHead } = fixture();
    let missingReads = 0;
    readHead.mockImplementation(async (platform) => {
      if (platform === 'ios' && heads.ios.updateId === restoredIds.ios) {
        missingReads++;
        return { updateId: null, contentSha256: null };
      }
      return { ...heads[platform] };
    });
    await expect(run([0, 0])).rejects.toThrow('did not preserve the staged control');
    expect(missingReads).toBe(1);
  });
});
