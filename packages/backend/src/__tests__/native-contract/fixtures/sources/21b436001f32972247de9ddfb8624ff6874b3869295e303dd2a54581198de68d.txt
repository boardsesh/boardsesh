// The `x-boardsesh-client` value this binary sends on every backend request
// (HTTP header) and WebSocket handshake (connectionParams.clientIdentity), so
// the backend can tell the app apart from other clients. See
// packages/shared-schema/src/client-identity.ts for the contract.
//
// Deliberately free of expo-updates (unstubbed under vitest, see the note on
// setOtaSentryTags in ./sentry.ts): the identity names the binary, not the OTA
// bundle running on it. The Expo-web build uses ./client-identity.web.ts.
import { Platform } from 'react-native';
import * as Application from 'expo-application';
import { CLIENT_IDENTITY_HEADER, formatClientIdentity, UNKNOWN_CLIENT } from '@boardsesh/shared-schema/client-identity';

export const MOBILE_CLIENT_NAME = 'boardsesh-mobile';

let cachedHeaderValue: string | null = null;

/** e.g. `boardsesh-mobile/2.6.0 (ios; build 45)`. Read once per launch. */
export function getClientIdentityHeaderValue(): string {
  if (cachedHeaderValue === null) {
    cachedHeaderValue = formatClientIdentity({
      name: MOBILE_CLIENT_NAME,
      version: Application.nativeApplicationVersion || UNKNOWN_CLIENT,
      platform: Platform.OS,
      build: Application.nativeBuildVersion || undefined,
    });
  }
  return cachedHeaderValue;
}

/**
 * The identity as a header record, for the few raw `fetch` calls to the backend
 * that do not go through `authenticatedFetch` (auth endpoints, the token
 * refresh, push-device registration).
 */
export function clientIdentityHeaders(): Record<string, string> {
  return { [CLIENT_IDENTITY_HEADER]: getClientIdentityHeaderValue() };
}

/** Test-only: forget the memoised value so a suite can change the mocks. */
export function resetClientIdentityForTests(): void {
  cachedHeaderValue = null;
}
