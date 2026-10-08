// Expo-web fork of ./client-identity.ts. Browsers have no native binary, so
// expo-application's nativeApplicationVersion is null here; the app config's
// version (the same marketing version the store binaries ship) stands in.
import Constants from 'expo-constants';
import { formatClientIdentity, UNKNOWN_CLIENT } from '@boardsesh/shared-schema/client-identity';

export const MOBILE_WEB_CLIENT_NAME = 'boardsesh-mobile-web';

let cachedHeaderValue: string | null = null;

/** e.g. `boardsesh-mobile-web/2.6.0 (web)`. Read once per page load. */
export function getClientIdentityHeaderValue(): string {
  if (cachedHeaderValue === null) {
    cachedHeaderValue = formatClientIdentity({
      name: MOBILE_WEB_CLIENT_NAME,
      version: Constants.expoConfig?.version || UNKNOWN_CLIENT,
      platform: 'web',
    });
  }
  return cachedHeaderValue;
}

/** Test-only: forget the memoised value so a suite can change the mocks. */
export function resetClientIdentityForTests(): void {
  cachedHeaderValue = null;
}
