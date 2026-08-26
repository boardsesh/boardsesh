import { describe, expect, it, vi } from 'vitest';
import { OTA_CHANNEL_OVERRIDE_KEY } from '../channel-switch';
import {
  isBranchSurfingBuild,
  OTA_BRANCH_SURFING_MIGRATION_KEY,
  prepareOtaBranchSurfing,
} from '../legacy-ota-channel-migration';

function dependencies(branchSurfingBuild: boolean, migrationComplete: boolean | null = null) {
  return {
    branchSurfingBuild,
    readMigrationComplete: vi.fn().mockResolvedValue(migrationComplete),
    clearRequestHeadersOverride: vi.fn().mockResolvedValue(undefined),
    removeLegacyMirror: vi.fn().mockResolvedValue(undefined),
    markMigrationComplete: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
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

describe('prepareOtaBranchSurfing', () => {
  it('clears native state even when the best-effort legacy mirror is absent, then reloads', async () => {
    const deps = dependencies(true);

    await expect(prepareOtaBranchSurfing(deps)).resolves.toBe('reloading');
    expect(deps.readMigrationComplete).toHaveBeenCalledWith(OTA_BRANCH_SURFING_MIGRATION_KEY);
    expect(deps.clearRequestHeadersOverride).toHaveBeenCalledOnce();
    expect(deps.removeLegacyMirror).toHaveBeenCalledWith(OTA_CHANNEL_OVERRIDE_KEY);
    expect(deps.markMigrationComplete).toHaveBeenCalledWith(OTA_BRANCH_SURFING_MIGRATION_KEY, true);
    expect(deps.reload).toHaveBeenCalledOnce();
  });

  it('preserves xprem branch state after the one-time migration completed', async () => {
    const deps = dependencies(true, true);

    await expect(prepareOtaBranchSurfing(deps)).resolves.toBe('ready');
    expect(deps.clearRequestHeadersOverride).not.toHaveBeenCalled();
    expect(deps.removeLegacyMirror).not.toHaveBeenCalled();
    expect(deps.markMigrationComplete).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('leaves EAS preview-build overrides intact', async () => {
    const deps = dependencies(false);

    await expect(prepareOtaBranchSurfing(deps)).resolves.toBe('skipped');
    expect(deps.readMigrationComplete).not.toHaveBeenCalled();
    expect(deps.clearRequestHeadersOverride).not.toHaveBeenCalled();
  });

  it('does not mark or reload after a native-clear failure', async () => {
    const deps = dependencies(true);
    const failure = new Error('native storage unavailable');
    deps.clearRequestHeadersOverride.mockRejectedValueOnce(failure);

    await expect(prepareOtaBranchSurfing(deps)).rejects.toBe(failure);
    expect(deps.markMigrationComplete).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it('does not reload until mirror removal and completion persistence succeed', async () => {
    const deps = dependencies(true);
    const failure = new Error('async storage unavailable');
    deps.removeLegacyMirror.mockRejectedValueOnce(failure);

    await expect(prepareOtaBranchSurfing(deps)).rejects.toBe(failure);
    expect(deps.markMigrationComplete).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });
});
