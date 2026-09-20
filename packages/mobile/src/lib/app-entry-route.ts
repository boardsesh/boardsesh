/** Ordinary entry reuses the saved board in Climbs. Screenshot captures have
 * an explicit Home readiness contract before navigating to each capture. */
export function getAppEntryTab(): 'home' | 'climbs' {
  return process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' ? 'home' : 'climbs';
}

export function getAppEntryHref(): '/(tabs)/home' | '/(tabs)/climbs' {
  return `/(tabs)/${getAppEntryTab()}`;
}
