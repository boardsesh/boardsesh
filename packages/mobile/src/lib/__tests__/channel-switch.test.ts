import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resetOtaOperationOwnerForTests, runOtaOperation } from '../ota-operation-owner';
import {
  PRESET_CHANNELS,
  buildChannelList,
  performChannelSwitch,
  performChannelReset,
  type ChannelSwitchDeps,
} from '../channel-switch';

beforeEach(() => resetOtaOperationOwnerForTests());
afterEach(() => vi.useRealTimers());

function makeDeps(overrides: Partial<ChannelSwitchDeps> = {}): ChannelSwitchDeps {
  return {
    applyOverride: vi.fn(),
    checkForUpdate: vi.fn().mockResolvedValue({ isAvailable: true }),
    fetchUpdate: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    writeMirror: vi.fn().mockResolvedValue(undefined),
    clearMirror: vi.fn().mockResolvedValue(undefined),
    onMirrorError: vi.fn(),
    ...overrides,
  };
}

describe('buildChannelList', () => {
  it('returns the presets when there is no override', () => {
    expect(buildChannelList(null)).toEqual([...PRESET_CHANNELS]);
  });

  it('does not duplicate an override that is already a preset', () => {
    expect(buildChannelList('preview-2')).toEqual([...PRESET_CHANNELS]);
  });

  it('appends a custom override that is not a preset', () => {
    expect(buildChannelList('my-feature')).toEqual([...PRESET_CHANNELS, 'my-feature']);
  });
});

describe('performChannelSwitch', () => {
  it('happy path: overrides, fetches, mirrors, reloads → switched', async () => {
    const deps = makeDeps();
    const result = await performChannelSwitch('preview-3', null, 'rtv-1', deps);

    expect(result).toEqual({ status: 'switched' });
    expect(deps.applyOverride).toHaveBeenCalledWith('preview-3');
    expect(deps.fetchUpdate).toHaveBeenCalledOnce();
    expect(deps.writeMirror).toHaveBeenCalledWith('preview-3');
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  it('no compatible update: reverts the override + mirror, never reloads', async () => {
    const deps = makeDeps({ checkForUpdate: vi.fn().mockResolvedValue({ isAvailable: false }) });
    const result = await performChannelSwitch('preview-4', 'preview-1', 'rtv-1', deps);

    expect(result.status).toBe('reverted');
    // override reverted to the previously-active channel...
    expect(deps.applyOverride).toHaveBeenLastCalledWith('preview-1');
    // ...and the mirror restored to it (not cleared).
    expect(deps.writeMirror).toHaveBeenCalledWith('preview-1');
    expect(deps.clearMirror).not.toHaveBeenCalled();
    expect(deps.fetchUpdate).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('no previous override: a pre-commit failure clears the mirror', async () => {
    const deps = makeDeps({ fetchUpdate: vi.fn().mockRejectedValue(new Error('network')) });
    const result = await performChannelSwitch('preview-2', null, 'rtv-1', deps);

    expect(result.status).toBe('reverted');
    expect(deps.applyOverride).toHaveBeenLastCalledWith(null);
    expect(deps.clearMirror).toHaveBeenCalledOnce();
    expect(deps.writeMirror).not.toHaveBeenCalled();
  });

  it('reload fails AFTER the update is downloaded: keeps the override → pending-restart', async () => {
    const deps = makeDeps({ reload: vi.fn().mockRejectedValue(new Error('reload blew up')) });
    const result = await performChannelSwitch('preview-3', 'production', 'rtv-1', deps);

    expect(result).toEqual({ status: 'pending-restart' });
    // committed: the override is NOT reverted (last applyOverride is still the target).
    expect(deps.applyOverride).toHaveBeenCalledTimes(1);
    expect(deps.applyOverride).toHaveBeenCalledWith('preview-3');
    expect(deps.writeMirror).toHaveBeenCalledWith('preview-3');
  });

  it('a failed mirror write after commit is reported, not fatal', async () => {
    const deps = makeDeps({ writeMirror: vi.fn().mockRejectedValue(new Error('storage full')) });
    const result = await performChannelSwitch('preview-2', null, 'rtv-1', deps);

    expect(result).toEqual({ status: 'switched' });
    expect(deps.onMirrorError).toHaveBeenCalledOnce();
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  it('drains a timed-out check before restoring headers and running another operation', async () => {
    vi.useFakeTimers();
    let finishCheck: (answer: { isAvailable: boolean }) => void = () => {};
    const deps = makeDeps({
      checkForUpdate: vi.fn(
        () =>
          new Promise<{ isAvailable: boolean }>((resolve) => {
            finishCheck = resolve;
          }),
      ),
    });
    const switched = performChannelSwitch('preview-3', 'production', 'rtv-1', deps, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect((await switched).status).toBe('reverted');
    const next = vi.fn(async () => {});
    const queued = runOtaOperation(next);
    await vi.advanceTimersByTimeAsync(0);
    expect(next).not.toHaveBeenCalled();
    expect(deps.applyOverride).toHaveBeenCalledTimes(1);
    finishCheck({ isAvailable: true });
    await vi.advanceTimersByTimeAsync(0);
    await queued;
    expect(deps.applyOverride).toHaveBeenLastCalledWith('production');
    expect(deps.fetchUpdate).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not write restoration headers when its idle wait expires', async () => {
    vi.useFakeTimers();
    const deps = makeDeps({ waitForIdle: (lease) => lease.waitFor(new Promise<void>(() => {})) });
    const switched = performChannelSwitch('preview-3', 'production', 'rtv-1', deps, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect((await switched).status).toBe('reverted');
    expect(deps.applyOverride).not.toHaveBeenCalled();
    expect(deps.checkForUpdate).not.toHaveBeenCalled();
  });

  it('restores the prior channel when a cached download cannot launch under the target headers', async () => {
    const deps = makeDeps({ canLaunchFetchedUpdate: vi.fn().mockResolvedValue(false) });
    expect((await performChannelSwitch('preview-3', 'preview-1', 'rtv-1', deps)).status).toBe('reverted');
    expect(deps.applyOverride).toHaveBeenLastCalledWith('preview-1');
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('does not reload when the pending download changes during the mirror write', async () => {
    let finishMirror: () => void = () => {};
    let notifyMirrorStarted: () => void = () => {};
    const mirrorStarted = new Promise<void>((resolve) => {
      notifyMirrorStarted = resolve;
    });
    let downloadStillCurrent = true;
    const deps = makeDeps({
      canLaunchFetchedUpdate: vi.fn(async () => downloadStillCurrent),
      isFetchedUpdateCurrent: () => downloadStillCurrent,
      writeMirror: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishMirror = resolve;
            notifyMirrorStarted();
          }),
      ),
    });
    const switched = performChannelSwitch('preview-3', 'preview-1', 'rtv-1', deps);
    await mirrorStarted;
    downloadStillCurrent = false;
    finishMirror();
    expect(await switched).toEqual({ status: 'pending-restart' });
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.applyOverride).toHaveBeenCalledTimes(1);
  });
});

describe('performChannelReset', () => {
  it('restores the prior channel when the regular download has no launch proof', async () => {
    const deps = makeDeps({ canLaunchFetchedUpdate: vi.fn().mockResolvedValue(false) });
    expect((await performChannelReset('preview-2', deps)).status).toBe('failed');
    expect(deps.applyOverride).toHaveBeenLastCalledWith('preview-2');
    expect(deps.clearMirror).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('does not reload when the regular download changes during mirror cleanup', async () => {
    const deps = makeDeps({
      canLaunchFetchedUpdate: vi.fn().mockResolvedValue(true),
      isFetchedUpdateCurrent: vi.fn().mockReturnValue(false),
    });
    expect(await performChannelReset('preview-2', deps)).toEqual({ status: 'pending-restart' });
    expect(deps.clearMirror).toHaveBeenCalledOnce();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.applyOverride).toHaveBeenCalledTimes(1);
  });

  it('happy path: clears override + mirror, reloads → reset', async () => {
    const deps = makeDeps();
    const result = await performChannelReset('preview-2', deps);

    expect(result).toEqual({ status: 'reset' });
    expect(deps.applyOverride).toHaveBeenCalledWith(null);
    expect(deps.clearMirror).toHaveBeenCalledOnce();
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  it('pre-commit failure re-applies the previous override + mirror → failed', async () => {
    const deps = makeDeps({ checkForUpdate: vi.fn().mockRejectedValue(new Error('offline')) });
    const result = await performChannelReset('preview-2', deps);

    expect(result.status).toBe('failed');
    expect(deps.applyOverride).toHaveBeenNthCalledWith(1, null);
    expect(deps.applyOverride).toHaveBeenLastCalledWith('preview-2');
    // the mirror is restored to the previous channel (not cleared), so display matches native.
    expect(deps.writeMirror).toHaveBeenCalledWith('preview-2');
    expect(deps.clearMirror).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('pre-commit failure with no previous override clears the mirror', async () => {
    const deps = makeDeps({ checkForUpdate: vi.fn().mockRejectedValue(new Error('offline')) });
    const result = await performChannelReset(null, deps);

    expect(result.status).toBe('failed');
    expect(deps.applyOverride).toHaveBeenLastCalledWith(null);
    expect(deps.clearMirror).toHaveBeenCalledOnce();
    expect(deps.writeMirror).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('reload fails after commit → pending-restart, override stays cleared', async () => {
    const deps = makeDeps({ reload: vi.fn().mockRejectedValue(new Error('reload blew up')) });
    const result = await performChannelReset('preview-2', deps);

    expect(result).toEqual({ status: 'pending-restart' });
    expect(deps.applyOverride).toHaveBeenCalledTimes(1);
    expect(deps.applyOverride).toHaveBeenCalledWith(null);
    expect(deps.clearMirror).toHaveBeenCalledOnce();
  });
});
