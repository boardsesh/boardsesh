import { describe, expect, it, vi } from 'vitest';
import { OTA_CHANNEL_OVERRIDE_KEY } from '../channel-switch';
import { clearLegacyOtaChannelOverride } from '../legacy-ota-channel-migration';

function dependencies(branchSurfingBuild: boolean, storedOverride: string | null) {
  return {
    branchSurfingBuild,
    readOverride: vi.fn().mockResolvedValue(storedOverride),
    clearRequestHeadersOverride: vi.fn().mockResolvedValue(undefined),
    removeOverride: vi.fn().mockResolvedValue(undefined),
  };
}

describe('clearLegacyOtaChannelOverride', () => {
  it('clears the native override and mirror on production builds', async () => {
    const deps = dependencies(true, 'pr-1234');

    await expect(clearLegacyOtaChannelOverride(deps)).resolves.toBe(true);
    expect(deps.clearRequestHeadersOverride).toHaveBeenCalledOnce();
    expect(deps.removeOverride).toHaveBeenCalledWith(OTA_CHANNEL_OVERRIDE_KEY);
  });

  it('does nothing when no legacy mirror exists', async () => {
    const deps = dependencies(true, null);

    await expect(clearLegacyOtaChannelOverride(deps)).resolves.toBe(false);
    expect(deps.clearRequestHeadersOverride).not.toHaveBeenCalled();
    expect(deps.removeOverride).not.toHaveBeenCalled();
  });

  it('leaves EAS preview-build overrides intact', async () => {
    const deps = dependencies(false, 'preview-2');

    await expect(clearLegacyOtaChannelOverride(deps)).resolves.toBe(false);
    expect(deps.readOverride).not.toHaveBeenCalled();
    expect(deps.clearRequestHeadersOverride).not.toHaveBeenCalled();
  });
});
