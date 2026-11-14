import { createCanonicalBrowserCoordinatorFrame } from '@boardsesh/auth-protocol/browser-coordinator-dom';

let current: {
  readonly origin: string;
  readonly frame: ReturnType<typeof createCanonicalBrowserCoordinatorFrame>;
} | null = null;
/** Coordinates only; the subsequent primary session response still determines
 * identity. No metadata cursor is accepted as an authenticated Session. */
export async function readCanonicalBrowserCoordinator(origin: string, signal: AbortSignal) {
  await coordinate(origin, signal, false);
}
/** Session refresh only. OAuth preflight keeps using the read-only method so
 * an existing account-change intent cannot block its own provider continuation. */
export async function renewCanonicalBrowserCoordinator(origin: string, signal: AbortSignal) {
  await coordinate(origin, signal, true);
}
async function coordinate(origin: string, signal: AbortSignal, renew: boolean) {
  if (typeof window === 'undefined') throw new Error('COORDINATOR_UNAVAILABLE');
  if (current && current.origin !== origin) throw new Error('COORDINATOR_UNAVAILABLE');
  if (!current || current.frame.isClosed())
    current = { origin, frame: createCanonicalBrowserCoordinatorFrame({ window, canonicalOrigin: origin }) };
  const observed = await (renew ? current.frame.renew(signal) : current.frame.read(signal));
  if (observed.status !== 'ready' || signal.aborted) throw new Error('COORDINATOR_UNAVAILABLE');
}
