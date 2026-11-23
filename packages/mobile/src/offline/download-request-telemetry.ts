// Request identities outlive a sync cycle, but never an account boundary (#7989).
// This settings ledger is attribution, not another download queue or event outbox.
import { randomUUID } from 'expo-crypto';
import {
  createDownloadRequestTracker,
  type DownloadRequestContext,
  type DownloadRequestCorrelation,
  type DownloadRequestLedger,
  type ScopeDownloadObservedInfo,
} from '@boardsesh/offline-sync';
import { SHARED_EVENTS, type AnalyticsEventProperties } from '@boardsesh/analytics';
import { getSetting, setSetting, subscribeSettings } from '../settings/hooks';
import { track } from '../lib/analytics';
import { readMobileReleaseContext } from '../lib/release-context';
import { measureOfflineDownloadStorage } from './download-storage-measurement';

const LEDGER_KEY = 'offlineDownloadRequestsV1';
let lastSampledRequestBatch: string | undefined;
let accountClearPending = false;

function releaseProperties(): AnalyticsEventProperties {
  const release = readMobileReleaseContext();
  return {
    ota_update_id: release.updateId,
    ota_runtime_version: release.runtimeVersion,
    ota_is_embedded: release.isEmbeddedLaunch,
    ota_branch: release.branch,
    ota_channel: release.channel,
  };
}

function contextProperties(context: DownloadRequestContext): AnalyticsEventProperties {
  return {
    requestId: context.requestId,
    batchId: context.batchId,
    scopeKey: context.scopeKey,
    trigger: context.trigger,
    source: context.source,
    requestedAt: context.requestedAt,
    requestedScopeCount: context.requestedScopeCount,
    ...releaseProperties(),
  };
}

// Lifecycle samples are observed device totals, never a claim about a peak the
// suspended JS runtime could not see. Device captures own the resource GO gate.
export function sampleDownloadStorage(downloadRequest: DownloadRequestCorrelation, phase: string): void {
  try {
    if (!downloadTransferProperties(downloadRequest).requestId) return;
    const measurement = measureOfflineDownloadStorage();
    track(SHARED_EVENTS.OfflineDownloadStorageSampled, {
      ...downloadRequest,
      phase,
      measuredAt: new Date().toISOString(),
      measurementAvailable: measurement !== null,
      ...measurement,
      peakCoverage: 'incomplete',
      ...releaseProperties(),
    });
  } catch {
    // Filesystem or analytics failures must not change a download's outcome.
  }
}

function tracker() {
  return createDownloadRequestTracker({
    read: () => getSetting(LEDGER_KEY),
    write: (ledger) => setSetting(LEDGER_KEY, ledger),
    createId: randomUUID,
    now: Date.now,
    report: ({ kind, context }) => {
      track(
        kind === 'requested'
          ? SHARED_EVENTS.OfflineBoardDownloadRequested
          : kind === 'started'
            ? SHARED_EVENTS.OfflineBoardDownloadRequestStarted
            : SHARED_EVENTS.OfflineBoardDownloadRequestResolved,
        {
          ...contextProperties(context),
          ...(kind === 'resolved' ? { outcome: context.state, resolvedAt: new Date().toISOString() } : {}),
        },
      );
      if (kind === 'resolved' || (kind === 'requested' && lastSampledRequestBatch !== context.batchId)) {
        lastSampledRequestBatch = context.batchId;
        sampleDownloadStorage(context, kind);
      }
    },
  });
}

// Persisting telemetry is best-effort. A refusal leaves an explicit measurement
// gap; it must never prevent the board preference or actual download from working.
export function recordDownloadRequests(
  scopes: readonly string[],
  options: { trigger: string; source: string; replaceDisabled?: boolean },
): void {
  try {
    if (accountClearPending) {
      tracker().clear();
      accountClearPending = false;
    }
    if (options.replaceDisabled && scopes.length > 0) {
      // The caller captured these scopes as disabled BEFORE enabling them. A
      // crash may have persisted the disable but not the old ledger cleanup.
      // Close that stale request instead of folding the new enable into it.
      const stored: unknown = getSetting(LEDGER_KEY);
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        const replaced = new Set(scopes);
        const retained: DownloadRequestLedger = {};
        for (const scopeKey of Object.keys(stored)) {
          const context = tracker().get(scopeKey);
          if (!context) continue;
          if (replaced.has(scopeKey)) tracker().resolve(scopeKey, 'cancelled');
          else retained[scopeKey] = context;
        }
        setSetting(LEDGER_KEY, retained);
      }
    }
    tracker().request(scopes, options);
  } catch {
    // Requested/start joins remain unknown if durable attribution was unavailable.
  }
}

export function getDownloadRequestContext(scopeKey: string): DownloadRequestCorrelation | undefined {
  if (accountClearPending) return undefined;
  try {
    const context = tracker().get(scopeKey);
    if (!context || context.state === 'cancelled') return undefined;
    return { requestId: context.requestId, batchId: context.batchId };
  } catch {
    return undefined;
  }
}

export function downloadRequestProperties(
  scopeKey: string,
  downloadRequest?: DownloadRequestCorrelation,
): AnalyticsEventProperties {
  if (!downloadRequest || accountClearPending) return {};
  try {
    const context = tracker().get(scopeKey);
    // An old cycle may finish after sign-out or a new enable of this scope.
    if (context?.requestId !== downloadRequest.requestId || context.batchId !== downloadRequest.batchId) return {};
    return contextProperties(context);
  } catch {
    return {};
  }
}

/** Preserve #7992's operational requestId/attemptId on legacy funnel events. */
export function downloadFunnelProperties(
  scopeKey: string,
  downloadRequest?: DownloadRequestCorrelation,
): AnalyticsEventProperties {
  const properties = downloadRequestProperties(scopeKey, downloadRequest);
  if (!properties.requestId) return {};
  return {
    bulkRequestId: properties.requestId,
    batchId: properties.batchId,
    requestedScopeCount: properties.requestedScopeCount,
    bulkRequestedAt: properties.requestedAt,
    ...releaseProperties(),
  };
}

/** Only decorate a physical transfer while its requesting account still owns the ledger. */
export function downloadTransferProperties(downloadRequest?: DownloadRequestCorrelation): AnalyticsEventProperties {
  if (!downloadRequest || accountClearPending) return {};
  try {
    const stored: unknown = getSetting(LEDGER_KEY);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    for (const scopeKey of Object.keys(stored)) {
      const properties = downloadRequestProperties(scopeKey, downloadRequest);
      if (properties.requestId) return properties;
    }
  } catch {
    // A late transfer must not borrow the next account's identity.
  }
  return {};
}

export function recordDownloadStarted(scopeKey: string, downloadRequest?: DownloadRequestCorrelation): void {
  if (!downloadRequest || !downloadRequestProperties(scopeKey, downloadRequest).requestId) return;
  try {
    tracker().started(scopeKey);
  } catch {
    // The existing start event still runs even if attribution cannot be updated.
  }
}

export function recordDownloadCompleted(scopeKey: string, downloadRequest?: DownloadRequestCorrelation): void {
  if (!downloadRequest || !downloadRequestProperties(scopeKey, downloadRequest).requestId) return;
  try {
    tracker().resolve(scopeKey, 'completed');
  } catch {
    // Completion markers and local availability are owned by the sync engine.
  }
}

export function observeDownloadScope(info: ScopeDownloadObservedInfo): void {
  if (!info.downloadRequest || !downloadRequestProperties(info.scopeKey, info.downloadRequest).requestId) return;
  if (!info.complete) {
    recordDownloadStarted(info.scopeKey, info.downloadRequest);
    return;
  }
  try {
    const current = tracker().get(info.scopeKey);
    // A marker committed before the process died is evidence of availability
    // now. Do not invent its original completion timestamp or backdate the event.
    tracker().resolve(info.scopeKey, current?.state === 'started' ? 'completed' : 'already_available');
  } catch {
    // The request remains unknown if we cannot persist the observation.
  }
}

export function clearDownloadRequestAttribution(): void {
  accountClearPending = true;
  try {
    tracker().clear();
    accountClearPending = false;
    lastSampledRequestBatch = undefined;
  } catch {
    // The account cleanup path must continue clearing the other user stores.
  }
}

subscribeSettings((change) => {
  if (change.kind === 'reset') {
    accountClearPending = false;
    lastSampledRequestBatch = undefined;
    return;
  }
  if (change.key !== 'syncEnabledBoards') return;
  try {
    const enabled = new Set(getSetting('syncEnabledBoards'));
    const stored: unknown = getSetting(LEDGER_KEY);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
    const retained: DownloadRequestLedger = {};
    let changed = false;
    for (const scopeKey of Object.keys(stored)) {
      const context = tracker().get(scopeKey);
      if (!context) {
        changed = true;
        continue;
      }
      if (enabled.has(scopeKey)) retained[scopeKey] = context;
      else {
        tracker().resolve(scopeKey, 'cancelled');
        changed = true;
      }
    }
    // Remove settled identities too: re-enabling cached data is a NEW request.
    // This bounds the ledger to enabled scopes, without evicting pending work.
    if (changed) setSetting(LEDGER_KEY, retained);
  } catch {
    // Cancelling a board cannot fail because its measurement store is unreadable.
  }
});
