/**
 * The board switcher (`/boards`) is a modal opened from a tab. After activating a
 * board it dismisses back to the tab it was opened from, passed as a `returnTo`
 * route param. Allow-list the value so a malformed or deep-linked param can't
 * redirect the user to an unexpected screen, and default to Climbs (the screen
 * the switcher has always returned to, including the onboarding hand-off).
 */
export type BoardReturnTo =
  | '/(tabs)/climbs'
  | '/(tabs)/discover'
  | '/(tabs)/record'
  | `/(tabs)/climbs/setter/${string}`;

export function setterPlaylistReturnTo(username: string): BoardReturnTo {
  return `/(tabs)/climbs/setter/${encodeURIComponent(username)}`;
}

export function resolveBoardReturnTo(value: string | undefined): BoardReturnTo {
  const setterPrefix = '/(tabs)/climbs/setter/';
  if (value?.startsWith(setterPrefix)) {
    const encodedUsername = value.slice(setterPrefix.length);
    try {
      const username = decodeURIComponent(encodedUsername);
      // Accept only one canonical encoded username segment, not arbitrary
      // routes, query strings, or traversal. Preserve spaces and Unicode names.
      if (
        username &&
        username !== '.' &&
        username !== '..' &&
        !/[\\/]/.test(username) &&
        encodeURIComponent(username) === encodedUsername
      ) {
        return setterPlaylistReturnTo(username);
      }
    } catch {
      // Invalid escapes are untrusted deep links; use the ordinary fallback.
    }
  }
  return value === '/(tabs)/discover' || value === '/(tabs)/record' ? value : '/(tabs)/climbs';
}
