/**
 * The offline engine depends on the native SQLite/filesystem stack. Keep it
 * disabled in Expo web for every input. The native fork is permanently on; the
 * parameter remains only to keep the platform modules type-compatible.
 */
export function isOfflineDownloadsEnabled(_featureFlag: boolean | undefined): boolean {
  return false;
}
