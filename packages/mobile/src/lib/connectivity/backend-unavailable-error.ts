import { BACKEND_UNAVAILABLE_ERROR_NAME } from '@boardsesh/offline-sync/error-classification';
import type { ConnectivityReason } from './connectivity-store';

// Engineer-facing, never rendered: the user-facing copy is localized at the
// surface that catches this. Kept distinct per reason so a Sentry breadcrumb or
// a dev console line says which side was down.
const BACKEND_UNAVAILABLE_MESSAGES: Record<ConnectivityReason, string> = {
  offline_mode: 'Request skipped: offline mode is on',
  device_offline: 'Request skipped: the device has no usable connection',
  backend_unreachable: 'Request skipped: the Boardsesh backend is unreachable',
};

/**
 * The rejection a GraphQL call gets when the app already knows the request
 * cannot land: the climber turned offline mode on, the phone has no uplink, or
 * the backend is confirmed unreachable (issue #4862).
 *
 * A LOCAL decision, not a server answer. Nothing was sent, so it is not a
 * failure of anything — which is exactly why `reportHandledError` drops it (one
 * outage would otherwise mint a Sentry issue per query) and why the React Query
 * retry policy refuses to retry it. `reason` is what the UI shows: "you're
 * offline" and "our server is down" are different sentences, and telling a
 * climber in a tunnel that Boardsesh is broken is the failure mode this whole
 * change exists to remove.
 *
 * `name` is the shared classifier's stable identifier (like
 * `GraphQLEmptyResponseError`), so the offline drainer and the shared error
 * classification recognise it across module instances without importing this
 * class.
 */
export class BackendUnavailableError extends Error {
  readonly reason: ConnectivityReason;

  constructor(reason: ConnectivityReason) {
    super(BACKEND_UNAVAILABLE_MESSAGES[reason]);
    this.name = BACKEND_UNAVAILABLE_ERROR_NAME;
    this.reason = reason;
  }
}

/**
 * Structural check by `name`, not `instanceof`. Metro and Vitest can both hand
 * out two copies of a module, and an `instanceof` that quietly returns false
 * would put the outage storm straight back into Sentry.
 */
export function isBackendUnavailableError(error: unknown): error is BackendUnavailableError {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { name?: unknown }).name === BACKEND_UNAVAILABLE_ERROR_NAME;
}
