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
  | '/(tabs)/home'
  | `/(tabs)/${SetterPlaylistTab}/setter/${string}`;

/** The tab stacks that hold a setter's list: Climbs, and Discover for a For You card. */
export type SetterPlaylistTab = 'climbs' | 'discover';
const SETTER_PLAYLIST_TABS: readonly SetterPlaylistTab[] = ['climbs', 'discover'];

function setterPlaylistPrefix(tab: SetterPlaylistTab): `/(tabs)/${SetterPlaylistTab}/setter/` {
  return `/(tabs)/${tab}/setter/`;
}

function setterPlaylistTabOf(value: string): SetterPlaylistTab | undefined {
  return SETTER_PLAYLIST_TABS.find((tab) => value.startsWith(setterPlaylistPrefix(tab)));
}

export function setterPlaylistReturnTo(username: string, tab: SetterPlaylistTab): BoardReturnTo {
  return `${setterPlaylistPrefix(tab)}${encodeURIComponent(username)}`;
}

/** The route a return names, for analytics: a setter's username becomes `[username]`. */
export function boardReturnToRoute(returnTo: BoardReturnTo): string {
  const setterTab = setterPlaylistTabOf(returnTo);
  return setterTab ? `${setterPlaylistPrefix(setterTab)}[username]` : returnTo;
}

function resolveSetterPlaylistReturnTo(value: string, tab: SetterPlaylistTab): BoardReturnTo | null {
  const encodedUsername = value.slice(setterPlaylistPrefix(tab).length);
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
      return setterPlaylistReturnTo(username, tab);
    }
  } catch {
    // Invalid escapes are untrusted deep links; use the ordinary fallback.
  }
  return null;
}

export function resolveBoardReturnTo(value: string | undefined): BoardReturnTo {
  const setterTab = value === undefined ? undefined : setterPlaylistTabOf(value);
  if (value !== undefined && setterTab) {
    const setterReturn = resolveSetterPlaylistReturnTo(value, setterTab);
    if (setterReturn) return setterReturn;
  }
  return value === '/(tabs)/discover' || value === '/(tabs)/record' || value === '/(tabs)/home'
    ? value
    : '/(tabs)/climbs';
}
