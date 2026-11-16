import { createCanonicalBrowserCoordinatorFrame } from '@boardsesh/auth-protocol/browser-coordinator-dom';

let current: {
  readonly origin: string;
  readonly frame: ReturnType<typeof createCanonicalBrowserCoordinatorFrame>;
} | null = null;
/** Coordinates only; the subsequent primary session response still determines
 * identity. The returned cursor is control metadata a caller may pin across its
 * next lock, never an authenticated Session. */
export async function readCanonicalBrowserCoordinator(origin: string, signal: AbortSignal) {
  return coordinate(origin, signal);
}
async function coordinate(origin: string, signal: AbortSignal) {
  if (typeof window === 'undefined') throw new Error('COORDINATOR_UNAVAILABLE');
  if (current && current.origin !== origin) throw new Error('COORDINATOR_UNAVAILABLE');
  if (!current || current.frame.isClosed())
    current = { origin, frame: createCanonicalBrowserCoordinatorFrame({ window, canonicalOrigin: origin }) };
  const observed = await current.frame.read(signal);
  if (observed.status !== 'ready' || signal.aborted) throw new Error('COORDINATOR_UNAVAILABLE');
  return Object.freeze({ ...observed.cursor });
}
