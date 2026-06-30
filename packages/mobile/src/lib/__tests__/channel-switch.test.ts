import { describe, it, expect, vi } from 'vitest';
import {
  PRESET_CHANNELS,
  buildChannelList,
  resolveBuildChannel,
  deriveChannelRowState,
  performChannelSwitch,
  performChannelReset,
  type ChannelSwitchDeps,
} from '../channel-switch';

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

describe('resolveBuildChannel', () => {
  it('falls back to production when expo-updates reports no channel', () => {
    expect(resolveBuildChannel(null)).toBe('production');
    expect(resolveBuildChannel(undefined)).toBe('production');
  });

  it('treats an empty-string channel as no channel', () => {
    expect(resolveBuildChannel('')).toBe('production');
  });

  it('passes a real build channel through unchanged', () => {
    expect(resolveBuildChannel('production')).toBe('production');
    expect(resolveBuildChannel('preview-2')).toBe('preview-2');
  });
});

describe('deriveChannelRowState', () => {
  const base = { channel: 'preview-1', activeChannel: 'production', switchingChannel: null, updatesUsable: true };

  it('an idle, inactive row on a usable build is pressable', () => {
    expect(deriveChannelRowState(base)).toEqual({
      isActive: false,
      isSwitching: false,
      isDisabled: false,
      isPressable: true,
    });
  });

  it('the active channel shows a checkmark and is not pressable', () => {
    expect(deriveChannelRowState({ ...base, channel: 'production' })).toMatchObject({
      isActive: true,
      isPressable: false,
    });
  });

  it('the row being switched to is marked switching, not disabled', () => {
    expect(deriveChannelRowState({ ...base, switchingChannel: 'preview-1' })).toMatchObject({
      isSwitching: true,
      isDisabled: false,
      isPressable: false,
    });
  });

  it('other rows are disabled while a different switch is in flight', () => {
    expect(deriveChannelRowState({ ...base, switchingChannel: 'preview-2' })).toMatchObject({
      isSwitching: false,
      isDisabled: true,
      isPressable: false,
    });
  });

  it('nothing is pressable when updates are unavailable (dev / Expo Go)', () => {
    expect(deriveChannelRowState({ ...base, updatesUsable: false })).toMatchObject({
      isActive: false,
      isPressable: false,
    });
  });

  it('the active channel is still marked active on an unusable build, just not pressable', () => {
    expect(deriveChannelRowState({ ...base, channel: 'production', updatesUsable: false })).toMatchObject({
      isActive: true,
      isPressable: false,
    });
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
});

describe('performChannelReset', () => {
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
