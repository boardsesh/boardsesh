import { describe, expect, it, vi } from 'vitest';
import { OTA_CHANNEL_OVERRIDE_KEY } from '../channel-switch';
import {
  clearRetiredChannelOverride,
  isBranchSurfingBuild,
  OTA_BRANCH_SURFING_MIGRATION_KEY,
  readBakedChannelName,
  wasStaleOverrideActive,
} from '../ota-channel-override-cleanup';

function dependencies(branchSurfingBuild: boolean, migrationComplete: boolean | null = null) {
  return {
    branchSurfingBuild,
    readMigrationComplete: vi.fn().mockResolvedValue(migrationComplete),
    clearRequestHeadersOverride: vi.fn().mockResolvedValue(undefined),
    removeLegacyMirror: vi.fn().mockResolvedValue(undefined),
    markMigrationComplete: vi.fn().mockResolvedValue(undefined),
  };
}

const SELF_HOSTED_CONFIG = {
  url: 'https://updates.boardsesh.com/manifest',
  requestHeaders: {
    'expo-app-id': 'app-id',
    'expo-channel-name': 'production',
    'xprem-branch': '',
  },
};

describe('isBranchSurfingBuild', () => {
  it('uses immutable self-hosted headers instead of the effective runtime channel', () => {
    expect(isBranchSurfingBuild({ development: false, updatesEnabled: true, updatesConfig: SELF_HOSTED_CONFIG })).toBe(
      true,
    );
  });

  it('rejects EAS builds that do not declare the branch header', () => {
    expect(
      isBranchSurfingBuild({
        development: false,
        updatesEnabled: true,
        updatesConfig: { url: 'https://u.expo.dev/project-id' },
      }),
    ).toBe(false);
  });

  it('rejects development and disabled-updates builds', () => {
    expect(isBranchSurfingBuild({ development: true, updatesEnabled: true, updatesConfig: SELF_HOSTED_CONFIG })).toBe(
      false,
    );
    expect(isBranchSurfingBuild({ development: false, updatesEnabled: false, updatesConfig: SELF_HOSTED_CONFIG })).toBe(
      false,
    );
  });
});

describe('clearRetiredChannelOverride', () => {
  it('keeps the marker key existing installs already hold', () => {
    expect(OTA_BRANCH_SURFING_MIGRATION_KEY).toBe('ota_branch_surfing_migration_v1');
  });

  it('clears native state even when the best-effort legacy mirror is absent', async () => {
    const deps = dependencies(true);

    await expect(clearRetiredChannelOverride(deps)).resolves.toBe('cleared');
    expect(deps.readMigrationComplete).toHaveBeenCalledWith(OTA_BRANCH_SURFING_MIGRATION_KEY);
    expect(deps.clearRequestHeadersOverride).toHaveBeenCalledOnce();
    expect(deps.removeLegacyMirror).toHaveBeenCalledWith(OTA_CHANNEL_OVERRIDE_KEY);
    expect(deps.markMigrationComplete).toHaveBeenCalledWith(OTA_BRANCH_SURFING_MIGRATION_KEY, true);
  });

  it('preserves xprem branch state after the one-time cleanup completed', async () => {
    const deps = dependencies(true, true);

    await expect(clearRetiredChannelOverride(deps)).resolves.toBe('already_clean');
    expect(deps.clearRequestHeadersOverride).not.toHaveBeenCalled();
    expect(deps.removeLegacyMirror).not.toHaveBeenCalled();
    expect(deps.markMigrationComplete).not.toHaveBeenCalled();
  });

  it('leaves EAS preview-build overrides intact', async () => {
    const deps = dependencies(false);

    await expect(clearRetiredChannelOverride(deps)).resolves.toBe('skipped');
    expect(deps.readMigrationComplete).not.toHaveBeenCalled();
    expect(deps.clearRequestHeadersOverride).not.toHaveBeenCalled();
  });

  it('does not mark after a native-clear failure, so the next launch tries again', async () => {
    const deps = dependencies(true);
    const failure = new Error('native storage unavailable');
    deps.clearRequestHeadersOverride.mockRejectedValueOnce(failure);

    await expect(clearRetiredChannelOverride(deps)).rejects.toBe(failure);
    expect(deps.markMigrationComplete).not.toHaveBeenCalled();
  });

  it('does not mark until mirror removal succeeds', async () => {
    const deps = dependencies(true);
    const failure = new Error('async storage unavailable');
    deps.removeLegacyMirror.mockRejectedValueOnce(failure);

    await expect(clearRetiredChannelOverride(deps)).rejects.toBe(failure);
    expect(deps.markMigrationComplete).not.toHaveBeenCalled();
  });
});

describe('readBakedChannelName', () => {
  it('reads the channel the binary was built for', () => {
    expect(readBakedChannelName(SELF_HOSTED_CONFIG)).toBe('production');
  });

  it('answers null for a config without baked headers', () => {
    expect(readBakedChannelName({ url: 'https://u.expo.dev/project-id' })).toBeNull();
    expect(readBakedChannelName(undefined)).toBeNull();
  });
});

describe('wasStaleOverrideActive', () => {
  it('is true when this launch cleared an override that had moved the channel', () => {
    expect(
      wasStaleOverrideActive({ cleanup: 'cleared', launchChannel: 'preview-12', bakedChannel: 'production' }),
    ).toBe(true);
  });

  it('is false on a fresh install: it reports cleared, but never had an override', () => {
    expect(
      wasStaleOverrideActive({ cleanup: 'cleared', launchChannel: 'production', bakedChannel: 'production' }),
    ).toBe(false);
  });

  it('is false when nothing was cleared this launch, whatever the channel says', () => {
    // A later launch may legitimately run under xprem's own branch override.
    expect(
      wasStaleOverrideActive({ cleanup: 'already_clean', launchChannel: 'preview-12', bakedChannel: 'production' }),
    ).toBe(false);
    expect(
      wasStaleOverrideActive({ cleanup: 'skipped', launchChannel: 'preview-12', bakedChannel: 'production' }),
    ).toBe(false);
  });

  it('is false when either channel is unknown, rather than guessing', () => {
    expect(wasStaleOverrideActive({ cleanup: 'cleared', launchChannel: null, bakedChannel: 'production' })).toBe(false);
    expect(wasStaleOverrideActive({ cleanup: 'cleared', launchChannel: 'preview-12', bakedChannel: null })).toBe(false);
  });
});
