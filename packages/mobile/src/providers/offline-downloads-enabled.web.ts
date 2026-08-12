/**
 * The offline engine depends on the native SQLite/filesystem stack. Keep it
 * disabled in Expo web for every input — including the unresolved `undefined`
 * that the native fork now reads as ON (see the `.ts` sibling and issue #4312)
 * and a tester override that forces the flag on.
 */
export function isOfflineDownloadsEnabled(_featureFlag: boolean | undefined): boolean {
  return false;
}
