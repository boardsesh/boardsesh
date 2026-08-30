import * as Updates from 'expo-updates';
import { assertNetworkAllowed } from './network-policy';

/**
 * The only app-owned entry points for OTA network I/O. Expo's automatic check
 * is disabled in app.config.ts; routing every foreground check and download
 * through these guards makes the persisted offline policy authoritative.
 */
export function checkForOtaUpdate() {
  assertNetworkAllowed('ota');
  return Updates.checkForUpdateAsync();
}

export function fetchOtaUpdate() {
  assertNetworkAllowed('ota');
  return Updates.fetchUpdateAsync();
}
