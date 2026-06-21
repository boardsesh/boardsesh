/**
 * The board switcher (`/boards`) is a modal opened from a tab. After activating a
 * board it dismisses back to the tab it was opened from, passed as a `returnTo`
 * route param. Allow-list the value so a malformed or deep-linked param can't
 * redirect the user to an unexpected screen, and default to Climbs (the screen
 * the switcher has always returned to, including the onboarding hand-off).
 */
export type BoardReturnTo = '/(tabs)/climbs' | '/(tabs)/discover';

export function resolveBoardReturnTo(value: string | undefined): BoardReturnTo {
  return value === '/(tabs)/discover' ? '/(tabs)/discover' : '/(tabs)/climbs';
}
