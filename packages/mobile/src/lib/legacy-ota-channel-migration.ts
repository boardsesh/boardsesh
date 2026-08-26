import { OTA_CHANNEL_OVERRIDE_KEY } from './channel-switch';

export const OTA_BRANCH_SURFING_MIGRATION_KEY = 'ota_branch_surfing_migration_v1';

const REQUIRED_BRANCH_SURFING_HEADERS = ['expo-app-id', 'expo-channel-name', 'xprem-branch'] as const;

type BranchSurfingBuildInput = {
  development: boolean;
  updatesEnabled: boolean;
  updatesConfig: unknown;
};

/**
 * Identify the new self-hosted cohort from its fingerprint-bound Expo config,
 * never from Updates.channel. Expo may source expoConfig from the running update,
 * but requestHeaders move runtimeVersion: an update declaring these keys cannot
 * execute on an older binary that did not bake them. Updates.channel reflects a
 * persisted request-header override, so a production install left on a legacy
 * preview channel can report preview-N at launch.
 */
export function isBranchSurfingBuild({ development, updatesEnabled, updatesConfig }: BranchSurfingBuildInput): boolean {
  if (development || !updatesEnabled || typeof updatesConfig !== 'object' || updatesConfig === null) return false;

  const config = updatesConfig as Record<string, unknown>;
  if (typeof config.url !== 'string' || config.url.length === 0) return false;
  if (typeof config.requestHeaders !== 'object' || config.requestHeaders === null) return false;

  const requestHeaders = config.requestHeaders as Record<string, unknown>;
  return REQUIRED_BRANCH_SURFING_HEADERS.every((header) => typeof requestHeaders[header] === 'string');
}

type OtaBranchSurfingPreparationDependencies = {
  branchSurfingBuild: boolean;
  readMigrationComplete: (key: string) => Promise<boolean | null>;
  clearRequestHeadersOverride: () => void | Promise<void>;
  removeLegacyMirror: (key: string) => Promise<void>;
  markMigrationComplete: (key: string, complete: boolean) => Promise<void>;
  reload: () => Promise<void>;
};

export type OtaBranchSurfingPreparation = 'skipped' | 'ready' | 'reloading';

/**
 * Clear Boardsesh's retired channel override exactly once before xprem mounts.
 *
 * The old AsyncStorage mirror was best-effort, so its absence does not prove the
 * native override is absent. A dedicated completion marker lets the first new
 * build clear native state unconditionally, while preserving xprem's own branch
 * override on every later launch. Changing the native headers requires a reload:
 * Updates.channel is a module constant for the current JS runtime and xprem reads
 * it when the ControlCenter mounts.
 */
export async function prepareOtaBranchSurfing({
  branchSurfingBuild,
  readMigrationComplete,
  clearRequestHeadersOverride,
  removeLegacyMirror,
  markMigrationComplete,
  reload,
}: OtaBranchSurfingPreparationDependencies): Promise<OtaBranchSurfingPreparation> {
  if (!branchSurfingBuild) return 'skipped';

  const migrationComplete = await readMigrationComplete(OTA_BRANCH_SURFING_MIGRATION_KEY);
  if (migrationComplete === true) return 'ready';

  await clearRequestHeadersOverride();
  await removeLegacyMirror(OTA_CHANNEL_OVERRIDE_KEY);
  await markMigrationComplete(OTA_BRANCH_SURFING_MIGRATION_KEY, true);
  await reload();
  return 'reloading';
}
