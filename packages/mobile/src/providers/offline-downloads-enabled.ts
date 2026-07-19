/**
 * Native builds may enable the offline engine when the rollout flag is on.
 * Expo web replaces this module with the `.web` fork below.
 */
export function isOfflineDownloadsEnabled(featureFlag: boolean | undefined): boolean {
  return featureFlag === true;
}
