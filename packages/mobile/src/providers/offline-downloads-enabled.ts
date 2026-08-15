/**
 * Native offline mode is permanently enabled. The unused parameter preserves
 * the platform-gate signature while callers shed the former PostHog flag.
 * Expo web replaces this module with the `.web` fork and remains disabled.
 */
export function isOfflineDownloadsEnabled(_featureFlag: boolean | undefined): boolean {
  return true;
}
