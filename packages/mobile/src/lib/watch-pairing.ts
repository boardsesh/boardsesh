import { authenticatedFetch } from './auth-interceptor';
import { BACKEND_URL } from './env';

// Re-export the pure countdown helper so consumers keep a single import site
// (`from './watch-pairing'`) while the helper itself stays dependency-free and
// directly unit-testable.
export { remainingSeconds } from './watch-pairing-countdown';

/** A short-lived code the user types on their Garmin watch to link it to their account. */
export type WatchPairingCode = {
  /** The short code shown to the user. */
  code: string;
  /** ISO-8601 timestamp after which the code stops working. */
  expiresAt: string;
};

/**
 * Ask the backend for a fresh watch-pairing code. `authenticatedFetch` attaches
 * the bearer token, refreshes it when stale, and retries once on 401 — mirroring
 * the avatar upload REST call. The watch enters the returned `code` to link.
 */
export async function requestWatchPairingCode(): Promise<WatchPairingCode> {
  const response = await authenticatedFetch(`${BACKEND_URL}/api/watch/pair-code`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`pair-code ${response.status}`);
  }
  return response.json() as Promise<WatchPairingCode>;
}
