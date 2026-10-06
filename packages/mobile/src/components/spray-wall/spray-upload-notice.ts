// What the add-a-wall wizard says when the photo cannot go up because the app
// is offline, rather than the generic "The photo didn't make it up." (#5960).
//
// Three different fixes, so three different sentences: Offline mode is a switch
// the climber turned on, no signal is the phone's, and an unreachable backend is
// ours. `useConnectivity().reason` already tells them apart.

import {
  BACKEND_UNAVAILABLE_ERROR_NAME,
  isNetworkError,
  isServerUnavailableError,
} from '@boardsesh/offline-sync/error-classification';
import type { ConnectivityReason } from '../../lib/connectivity/connectivity-store';
import { extractGraphqlCode } from '../../lib/graphql/extract-error-message';

export type SprayUploadNotice = 'offlineMode' | 'noSignal' | 'serverUnreachable';

export function sprayUploadNotice(reason: ConnectivityReason | null): SprayUploadNotice | null {
  switch (reason) {
    case 'offline_mode':
      return 'offlineMode';
    case 'device_offline':
      return 'noSignal';
    case 'backend_unreachable':
      return 'serverUnreachable';
    default:
      return null;
  }
}

/** `BackendUnavailableError`, matched by name so it is recognised across module instances. */
function backendUnavailableReason(error: unknown): ConnectivityReason | null {
  if (!(error instanceof Error) || error.name !== BACKEND_UNAVAILABLE_ERROR_NAME) return null;
  const { reason } = error as Error & { reason?: ConnectivityReason };
  return reason ?? null;
}

/**
 * Which connectivity message a failed upload gets, decided ONCE, when it fails.
 *
 * Only a failure that never got a server answer is a network failure. A server
 * refusal (any GraphQL code, the wall cap among them) keeps its own message even
 * if the phone drops offline afterwards, and an online connectivity state never
 * hides one either. Null means "not a network failure: say what the server said".
 *
 * @param reasonAtFailure `useConnectivity().reason` read in the `catch`.
 */
export function classifySprayUploadFailure(
  error: unknown,
  reasonAtFailure: ConnectivityReason | null,
): SprayUploadNotice | null {
  // The app refused the request itself (Offline mode, or a backend it already
  // knows is down) and says why.
  const refusedLocally = backendUnavailableReason(error);
  if (refusedLocally) return sprayUploadNotice(refusedLocally);
  if (extractGraphqlCode(error) !== null) return null;
  if (isServerUnavailableError(error)) return 'serverUnreachable';
  if (!isNetworkError(error)) return null;
  return sprayUploadNotice(reasonAtFailure) ?? 'noSignal';
}
