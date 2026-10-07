import { beforeEach, describe, expect, it, vi } from 'vitest';

const updates = vi.hoisted(() => ({
  isEnabled: true,
  channel: 'production' as string | null,
  setUpdateRequestHeadersOverride: vi.fn(),
}));
const preferences = vi.hoisted(() => ({
  stored: new Map<string, unknown>(),
  getPreference: vi.fn(),
  setPreference: vi.fn(),
  removePreference: vi.fn(),
}));

vi.mock('expo-updates', () => ({
  get isEnabled() {
    return updates.isEnabled;
  },
  get channel() {
    return updates.channel;
  },
  setUpdateRequestHeadersOverride: updates.setUpdateRequestHeadersOverride,
}));
vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      updates: {
        url: 'https://updates.boardsesh.com/manifest',
        requestHeaders: { 'expo-app-id': 'app-id', 'expo-channel-name': 'production', 'xprem-branch': '' },
      },
    },
  },
}));
vi.mock('../preference-store', () => ({
  getPreference: preferences.getPreference,
  setPreference: preferences.setPreference,
  removePreference: preferences.removePreference,
}));
// `__DEV__` is true under Vitest, which would make every build a non-surfing
// one. Keep the real cleanup and override only the build check.
vi.mock('../ota-channel-override-cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ota-channel-override-cleanup')>()),
  isBranchSurfingBuild: () => true,
}));

import {
  resetChannelOverrideCleanupRunForTests,
  runChannelOverrideCleanupOnce,
} from '../ota-channel-override-cleanup-run';

const MARKER_KEY = 'ota_branch_surfing_migration_v1';

beforeEach(() => {
  resetChannelOverrideCleanupRunForTests();
  updates.channel = 'production';
  updates.setUpdateRequestHeadersOverride.mockReset();
  preferences.stored = new Map();
  preferences.getPreference.mockReset().mockImplementation(async (key: string) => preferences.stored.get(key) ?? null);
  preferences.setPreference.mockReset().mockImplementation(async (key: string, value: unknown) => {
    preferences.stored.set(key, value);
  });
  preferences.removePreference.mockReset().mockResolvedValue(undefined);
});

describe('runChannelOverrideCleanupOnce', () => {
  it('runs the cleanup once per runtime and hands both callers the same result', async () => {
    const forInitializer = runChannelOverrideCleanupOnce();
    const forGate = runChannelOverrideCleanupOnce();

    expect(forGate).toBe(forInitializer);
    await expect(forInitializer).resolves.toEqual({ staleOverrideActive: false });
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenCalledExactlyOnceWith(null);
    expect(preferences.stored.get(MARKER_KEY)).toBe(true);

    // A later caller in the same runtime still gets the first run.
    expect(runChannelOverrideCleanupOnce()).toBe(forInitializer);
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenCalledOnce();
  });

  it('reports a stale override when this launch ran under a channel the binary was not built for', async () => {
    updates.channel = 'preview-12';

    await expect(runChannelOverrideCleanupOnce()).resolves.toEqual({ staleOverrideActive: true });
  });

  it('does not clear, and reports nothing stale, once the marker is set', async () => {
    preferences.stored.set(MARKER_KEY, true);
    // A later launch may legitimately run under xprem's own branch override.
    updates.channel = 'preview-12';

    await expect(runChannelOverrideCleanupOnce()).resolves.toEqual({ staleOverrideActive: false });
    expect(updates.setUpdateRequestHeadersOverride).not.toHaveBeenCalled();
  });

  it('keeps a rejection for both callers instead of retrying within the runtime', async () => {
    const failure = new Error('native storage unavailable');
    updates.setUpdateRequestHeadersOverride.mockImplementation(() => {
      throw failure;
    });

    await expect(runChannelOverrideCleanupOnce()).rejects.toBe(failure);
    await expect(runChannelOverrideCleanupOnce()).rejects.toBe(failure);
    expect(updates.setUpdateRequestHeadersOverride).toHaveBeenCalledOnce();
  });
});
