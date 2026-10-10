import { getConsentSnapshot } from './consent-state';

let pendingDestination: string | null = null;

const APP_SCHEME_PREFIX = 'com.boardsesh.app://';

/**
 * The in-app route an incoming OS link points at.
 *
 * Parsed by hand, not with `new URL()`: React Native's built-in `URL` only
 * understands http(s). For `com.boardsesh.app://join/abc` it reports an empty
 * hostname and a pathname of `/`, so every custom-scheme link collapsed to `//`
 * — which Expo Router reads as a protocol-relative external link and hands to
 * Safari as `https://`.
 */
function destinationOf(path: string): string {
  if (path.startsWith(APP_SCHEME_PREFIX)) {
    return `/${path.slice(APP_SCHEME_PREFIX.length).replace(/^\/+/, '')}`;
  }
  const universalLink = /^https?:\/\/[^/?#]+(.*)$/.exec(path);
  if (!universalLink) return path;
  const rest = universalLink[1];
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/** Last incoming OS destination wins; the privacy step must remain the focused route. */
export function deferConsentDestination(path: string): boolean {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' || getConsentSnapshot().settled) return false;
  const destination = destinationOf(path);
  // In-app links (a bare path or the app's own scheme) to auth and to the
  // consent step itself are left alone. Judged on the route, so every spelling
  // counts — `com.boardsesh.app:///auth/callback` included. A universal link is
  // deferred as before.
  const isUniversalLink = /^https?:\/\//.test(path);
  if (!isUniversalLink && (destination === '/privacy-consent' || destination.startsWith('/auth'))) return false;
  // A plain cold start reports the app's own root URL (`com.boardsesh.app:///`).
  // That is where the app opens anyway, so there is nothing to come back to —
  // and navigating to it later would re-run the root redirect into Home.
  if (destination === '/' || destination === '') return false;
  pendingDestination = destination;
  return true;
}

export function consumeConsentDestination(): string | null {
  const destination = pendingDestination;
  pendingDestination = null;
  return destination;
}
