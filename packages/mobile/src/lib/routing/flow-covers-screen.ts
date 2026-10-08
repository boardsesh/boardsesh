import { Platform } from 'react-native';

/**
 * Whether a full-height editing flow (New climb, the spray-wall flows) covers
 * the whole screen as a `fullScreenModal`: on iPad only.
 *
 * As a `modal` these flows are a page card on iPad, a ~540pt box in the middle
 * of the screen with the app dimmed around it, which is the wrong size for a
 * board you paint or pinch. iPad never mounts the iOS 26 NativeTabs
 * (`app/(tabs)/_layout.tsx` keeps it on JS tabs), so the `fullScreenModal` ban
 * in `docs/mobile-sheets-vs-routes.md` rule 2 does not reach it. Phones and
 * Android keep the `modal` presentation.
 *
 * Read on every call rather than once at load, so a test can vary the device.
 * A Mac running the iPad build reports `isPad` too, and gets a full-window cover.
 */
export function flowCoversScreen(): boolean {
  return Platform.OS === 'ios' && Platform.isPad === true;
}
