// Cleanup only: clears Boardsesh's retired OTA channel override, once per
// install. It never reloads the app. The deliberate launch-time reload onto a
// fresh bundle lives in `launch-update-gate.ts` (#6006); until then this file
// ended in `Updates.reloadAsync()`, and that side effect was the only thing
// moving a new install off its embedded bundle.
import { OTA_CHANNEL_OVERRIDE_KEY } from './channel-switch';

export const OTA_BRANCH_SURFING_MIGRATION_KEY = 'ota_branch_surfing_migration_v1';

const CHANNEL_NAME_HEADER = 'expo-channel-name';
const REQUIRED_BRANCH_SURFING_HEADERS = ['expo-app-id', CHANNEL_NAME_HEADER, 'xprem-branch'] as const;

type BranchSurfingBuildInput = {
  development: boolean;
  updatesEnabled: boolean;
  updatesConfig: unknown;
};

function readBakedRequestHeaders(updatesConfig: unknown): Record<string, unknown> | null {
  if (typeof updatesConfig !== 'object' || updatesConfig === null) return null;
  const config = updatesConfig as Record<string, unknown>;
  if (typeof config.url !== 'string' || config.url.length === 0) return null;
  if (typeof config.requestHeaders !== 'object' || config.requestHeaders === null) return null;
  return config.requestHeaders as Record<string, unknown>;
}

/**
 * Identify the new self-hosted cohort from its fingerprint-bound Expo config,
 * never from Updates.channel. Expo may source expoConfig from the running update,
 * but requestHeaders move runtimeVersion: an update declaring these keys cannot
 * execute on an older binary that did not bake them. Updates.channel reflects a
 * persisted request-header override, so a production install left on a legacy
 * preview channel can report preview-N at launch.
 */
export function isBranchSurfingBuild({ development, updatesEnabled, updatesConfig }: BranchSurfingBuildInput): boolean {
  if (development || !updatesEnabled) return false;

  const requestHeaders = readBakedRequestHeaders(updatesConfig);
  if (requestHeaders === null) return false;
  return REQUIRED_BRANCH_SURFING_HEADERS.every((header) => typeof requestHeaders[header] === 'string');
}

/** The channel this binary was built for, or null when the config declares none. */
export function readBakedChannelName(updatesConfig: unknown): string | null {
  const channelName = readBakedRequestHeaders(updatesConfig)?.[CHANNEL_NAME_HEADER];
  return typeof channelName === 'string' ? channelName : null;
}

type ChannelOverrideCleanupDependencies = {
  branchSurfingBuild: boolean;
  readMigrationComplete: (key: string) => Promise<boolean | null>;
  clearRequestHeadersOverride: () => void | Promise<void>;
  removeLegacyMirror: (key: string) => Promise<void>;
  markMigrationComplete: (key: string, complete: boolean) => Promise<void>;
};

/**
 * - `skipped`: not a Branch Surfing build, nothing touched.
 * - `already_clean`: the marker is set; an earlier launch did the work.
 * - `cleared`: this launch cleared the native override and set the marker.
 */
export type ChannelOverrideCleanupResult = 'skipped' | 'already_clean' | 'cleared';

/**
 * Clear Boardsesh's retired channel override exactly once per install.
 *
 * The old AsyncStorage mirror was best-effort, so its absence does not prove the
 * native override is absent. A dedicated completion marker lets the first new
 * build clear native state unconditionally, while preserving xprem's own branch
 * override on every later launch.
 *
 * Clearing takes effect for the NEXT manifest request in this process, but
 * `Updates.channel` is a module constant for the running JS runtime. So when an
 * override really was in effect, the launch-time request already went out with
 * it and the constant stays stale until a reload. The caller handles both:
 * `wasStaleOverrideActive` tells the launch update gate to check again with the
 * clean headers, and tells the QA surfaces not to trust this runtime's channel.
 */
export async function clearRetiredChannelOverride({
  branchSurfingBuild,
  readMigrationComplete,
  clearRequestHeadersOverride,
  removeLegacyMirror,
  markMigrationComplete,
}: ChannelOverrideCleanupDependencies): Promise<ChannelOverrideCleanupResult> {
  if (!branchSurfingBuild) return 'skipped';

  const migrationComplete = await readMigrationComplete(OTA_BRANCH_SURFING_MIGRATION_KEY);
  if (migrationComplete === true) return 'already_clean';

  await clearRequestHeadersOverride();
  await removeLegacyMirror(OTA_CHANNEL_OVERRIDE_KEY);
  await markMigrationComplete(OTA_BRANCH_SURFING_MIGRATION_KEY, true);
  return 'cleared';
}

type StaleOverrideInput = {
  cleanup: ChannelOverrideCleanupResult;
  /** `Updates.channel`: what this runtime was launched with, override included. */
  launchChannel: string | null | undefined;
  /** The channel baked into the binary. */
  bakedChannel: string | null;
};

/**
 * Whether this launch's manifest request went out under a retired override.
 * A fresh install also reports `cleared` (it has no marker yet) but never had an
 * override, so its launch channel equals the baked one and this is false.
 */
export function wasStaleOverrideActive({ cleanup, launchChannel, bakedChannel }: StaleOverrideInput): boolean {
  if (cleanup !== 'cleared') return false;
  if (bakedChannel === null || launchChannel === null || launchChannel === undefined) return false;
  return launchChannel !== bakedChannel;
}
