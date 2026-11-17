import { isWatchPairingCode, type WatchPairingCode } from '@boardsesh/watch-pairing';
import { authenticatedFetch } from './auth-interceptor';
import { BACKEND_URL } from './env';

// Re-export the shared pair-code type + pure countdown helper so consumers keep a
// single import site (`from './watch-pairing'`). The helpers themselves live in
// `@boardsesh/watch-pairing`, shared with the web settings section.
export { remainingSeconds, type WatchPairingCode } from '@boardsesh/watch-pairing';

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
  const data: unknown = await response.json();
  if (!isWatchPairingCode(data)) {
    throw new Error('pair-code bad response');
  }
  return data;
}
