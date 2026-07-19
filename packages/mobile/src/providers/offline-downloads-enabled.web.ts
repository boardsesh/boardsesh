/**
 * The offline engine depends on the native SQLite/filesystem stack. Keep it
 * disabled in Expo web even when PostHog or a tester override enables the flag.
 */
export function isOfflineDownloadsEnabled(_featureFlag: boolean | undefined): boolean {
  return false;
}
