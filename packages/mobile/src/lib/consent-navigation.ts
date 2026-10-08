import { getConsentSnapshot } from './consent-state';

let pendingDestination: string | null = null;

/** Last incoming OS destination wins; the privacy step must remain the focused route. */
export function deferConsentDestination(path: string): boolean {
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' || getConsentSnapshot().settled) return false;
  if (path === '/privacy-consent' || path.startsWith('/auth') || path.startsWith('com.boardsesh.app://auth/'))
    return false;
  try {
    const url = new URL(path);
    pendingDestination =
      url.protocol === 'com.boardsesh.app:'
        ? `/${url.hostname}${url.pathname}${url.search}`
        : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    pendingDestination = path;
  }
  return true;
}

export function consumeConsentDestination(): string | null {
  const destination = pendingDestination;
  pendingDestination = null;
  return destination;
}
