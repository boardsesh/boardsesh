import { Platform } from 'react-native';
import { useLaunchReady } from '../providers/launch-ready-context';

/**
 * Whether a surface the launch update placeholder cannot cover may go ahead.
 *
 * On iOS a root `modal` / `transparentModal` route is its own view controller
 * above the React root, so the placeholder sits underneath it. Anything that
 * presents one on a cold start (a deep link, a share, a notification tap) waits
 * for this, or the screen is usable while the gate may still reload (#6006).
 *
 * The browser target is never gated and has no native modal, so it is always
 * released: nothing about a web page load waits on this.
 */
export function useLaunchHoldReleased(): boolean {
  const launchReady = useLaunchReady();
  return launchReady || Platform.OS === 'web';
}
