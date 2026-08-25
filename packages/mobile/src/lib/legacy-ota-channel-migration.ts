import { OTA_CHANNEL_OVERRIDE_KEY } from './channel-switch';

type LegacyOtaChannelMigrationDependencies = {
  branchSurfingBuild: boolean;
  readOverride: (key: string) => Promise<string | null>;
  clearRequestHeadersOverride: () => void | Promise<void>;
  removeOverride: (key: string) => Promise<void>;
};

/**
 * Remove the request-header override written by Boardsesh's retired channel
 * picker before xprem's official branch picker mounts. EAS preview builds keep
 * their separate BranchSwitcher and are deliberately untouched.
 */
export async function clearLegacyOtaChannelOverride({
  branchSurfingBuild,
  readOverride,
  clearRequestHeadersOverride,
  removeOverride,
}: LegacyOtaChannelMigrationDependencies): Promise<boolean> {
  if (!branchSurfingBuild) return false;

  const legacyOverride = await readOverride(OTA_CHANNEL_OVERRIDE_KEY);
  if (legacyOverride === null) return false;

  await clearRequestHeadersOverride();
  await removeOverride(OTA_CHANNEL_OVERRIDE_KEY);
  return true;
}
