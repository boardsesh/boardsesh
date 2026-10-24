// Telemetry for the local-write retry ladder (issue #4315).
//
// A contended local SQLite write is invisible today unless it is a tick: the
// tick path reports to Sentry, but a favorite or follow whose transaction throws
// just rejects, the heart reverts, and nobody learns. This binds the shared
// ladder's `onSettled` seam to one PostHog event so every table's contention
// shows up in the same chart.
//
// Silent on a clean write — `onSettled` only fires when the first attempt threw
// — so the event's raw count is the contention rate, not the write rate.

import {
  isDatabaseLockedError,
  type LocalWriteRetryOptions,
  type LocalWriteRetryOutcome,
} from '@boardsesh/offline-sync';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../lib/analytics';
import { isOnline } from './offline-sync-adapter';
import { getJsRestartCount } from '../lib/launch-reload-window';

/**
 * Retry options carrying the `onSettled` reporter for one write.
 *
 * Never throws: a failed report must not turn a saved write into a lost one
 * (the shared ladder also guards this, so the try/catch here is belt and braces
 * for the property reads, mirroring `reportEnqueueSuppressed`).
 */
export function localWriteRetryOptions(
  tableName: string,
  operation: 'create' | 'delete',
): Pick<LocalWriteRetryOptions, 'onSettled'> {
  return {
    onSettled: ({ attempts, error, recovered, elapsedMs }: LocalWriteRetryOutcome) => {
      try {
        track(SHARED_EVENTS.OfflineLocalWriteAttemptFailed, {
          tableName,
          operation,
          attempts,
          elapsedMs,
          outcome: recovered ? 'recovered' : 'exhausted',
          isLockError: isDatabaseLockedError(error),
          wasOffline: !isOnline(),
          // Above zero, this runtime came from a reload. On Android a lock that
          // never frees after one is a transaction the old runtime left open (#6689).
          jsRestartCount: getJsRestartCount(),
        });
      } catch (reportError) {
        if (__DEV__) console.warn('[LocalWriteTelemetry] attempt-failed report failed:', reportError);
      }
    },
  };
}
