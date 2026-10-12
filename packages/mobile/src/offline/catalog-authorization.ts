import { AppState } from 'react-native';
import { onlineManager } from '@tanstack/react-query';
import { getPrivacyCredentialGeneration } from '../lib/privacy/privacy-cache';
import { clearSprayWallPrivateCaches } from '../lib/spray/spray-privacy-cleanup';
import { clearStoredSprayPhotos } from '../lib/spray/spray-photo-store';
import { reportHandledError } from '../lib/error-reporting';
import { getDatabaseHandle, subscribeDatabaseHandle } from '../db/connection';
import { getSetting } from '../settings';
import {
  PrivacyRevalidationDeferredError,
  reopenHeldCatalog,
  requirePrivacyRevalidation,
  revalidatePrivateCatalog,
} from './privacy-revalidation';
import { canReadPrivateCatalog, readCatalogStamp, subscribeCatalogCredentialMismatch } from './catalog-access';
import { subscribeMutationDelivery } from './offline-sync-adapter';

type OfflineDatabaseHandle = NonNullable<ReturnType<typeof getDatabaseHandle>>;

const RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

/**
 * Keep the downloaded catalogue authorized for one signed-in account until the
 * returned stop function runs.
 *
 * The app does not subscribe to the backend's `privacyChanged` event. Every
 * read is authorized by the server when it is made, live streams recheck access
 * on each event, and other people's feeds, sessions and profiles are fetched on
 * each view rather than stored. What stays on the phone is the offline
 * catalogue, and its reads are gated by a viewer marker bound to the credential
 * the server last checked. This runs the full catalogue revalidation, which
 * stamps that marker, in two cases:
 *
 * - the signed-in credential finds no marker at all: a new install, a catalogue
 *   wiped at sign-out, or a withdrawal that never finished. Checked at start and
 *   when a database handle is published.
 * - a local read finds a marker for an older credential: another account, or a
 *   refreshed token. Reported through `subscribeCatalogCredentialMismatch`.
 *
 * A revalidation that had to keep another account's rows (possible unsynced
 * work, or a climb a queued write names) leaves a held record instead of the
 * marker. That is not a reason to withdraw again: at start, and whenever a
 * queued write is delivered or dead-lettered, `reopenHeldCatalog` counts only
 * those rows and stamps the marker once none are left.
 */
export function startCatalogAuthorization(viewerId: string, isViewerCurrent: () => boolean): () => void {
  let disposed = false;
  let revision = 0;
  let dirty = false;
  let running = false;
  let retryIndex = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearRetry = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const currentViewer = () => !disposed && isViewerCurrent();
  const canAuthorize = () =>
    onlineManager.isOnline() && AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  const repair = async (persistWithdrawal = false): Promise<void> => {
    if (running || !dirty || !currentViewer() || (!persistWithdrawal && !canAuthorize())) return;
    const database = getDatabaseHandle();
    if (!database) return; // A published handle will resume this same withdrawal.
    running = true;
    dirty = false;
    const attemptRevision = revision;
    const credentialGeneration = getPrivacyCredentialGeneration();
    const isCurrent = () =>
      currentViewer() &&
      revision === attemptRevision &&
      getDatabaseHandle() === database &&
      getPrivacyCredentialGeneration() === credentialGeneration;
    try {
      await revalidatePrivateCatalog(database, viewerId, getSetting('syncEnabledBoards'), isCurrent, canAuthorize);
      if (isCurrent()) retryIndex = 0;
    } catch (error) {
      if (currentViewer() && revision === attemptRevision) {
        dirty = true;
        if (!(error instanceof PrivacyRevalidationDeferredError)) {
          reportHandledError(error, { tags: { source: 'privacy-revalidation' } });
        }
        const delay = canAuthorize() ? RETRY_DELAYS_MS[retryIndex++] : undefined;
        if (delay !== undefined)
          timer = setTimeout(() => {
            timer = undefined;
            void repair();
          }, delay);
      }
    } finally {
      running = false;
      // A request received during a repair must run once more; sharing the old
      // promise would authorize the catalogue for the older credential.
      if (currentViewer() && revision !== attemptRevision) void repair(true);
    }
  };
  const requestRepair = () => {
    if (!currentViewer()) return;
    clearSprayWallPrivateCaches();
    clearStoredSprayPhotos();
    requirePrivacyRevalidation();
    revision += 1;
    dirty = true;
    retryIndex = 0;
    clearRetry();
    void repair(true);
  };
  let reopening = false;
  let reopenAgain = false;
  const reopen = async (database: OfflineDatabaseHandle): Promise<void> => {
    if (reopening) {
      reopenAgain = true;
      return;
    }
    reopening = true;
    try {
      do {
        reopenAgain = false;
        // A repair in progress or waiting to run owns the catalogue.
        if (running || dirty || !currentViewer() || getDatabaseHandle() !== database) return;
        await reopenHeldCatalog(database, viewerId, () => currentViewer() && getDatabaseHandle() === database);
      } while (reopenAgain);
    } catch (error) {
      reportHandledError(error, { tags: { source: 'privacy-revalidation', step: 'reopen-held' } });
    } finally {
      reopening = false;
    }
  };
  const probe = async (database: OfflineDatabaseHandle): Promise<void> => {
    const stamp = await readCatalogStamp(database, viewerId);
    if (stamp === 'unstamped') {
      // A repair already requested deletes the marker first; that is not a
      // second reason to start over.
      if (revision === 0 && getDatabaseHandle() === database) requestRepair();
      return;
    }
    if (stamp === 'held') {
      await reopen(database);
      return;
    }
    // Local reads may beat profile readiness. A marker for an older credential
    // reaches the mismatch listener from this read, so a mismatch observed
    // during startup cannot be lost.
    await canReadPrivateCatalog(database);
  };
  const resume = () => {
    if (!dirty || !currentViewer()) return;
    retryIndex = 0;
    clearRetry();
    void repair();
  };
  const stopDatabase = subscribeDatabaseHandle(() => {
    if (!currentViewer()) return;
    if (revision === 0) {
      const database = getDatabaseHandle();
      if (database) void probe(database);
      return;
    }
    // Supersede the previous handle even if it is still finishing a write.
    requirePrivacyRevalidation();
    revision += 1;
    dirty = true;
    retryIndex = 0;
    clearRetry();
    void repair(true);
  });
  const stopOnline = onlineManager.subscribe((online) => {
    if (online) resume();
  });
  const foreground = AppState.addEventListener('change', (state) => {
    if (state === 'active') resume();
  });
  const stopCredentialMismatch = subscribeCatalogCredentialMismatch(requestRepair);
  // A delivered or dead-lettered write may have been the last thing keeping a
  // row, so reads can reopen in this launch rather than the next.
  const stopDelivery = subscribeMutationDelivery(() => {
    const database = getDatabaseHandle();
    if (!database || !currentViewer() || running || dirty) return;
    void readCatalogStamp(database, viewerId).then((stamp) => {
      if (stamp === 'held') void reopen(database);
    });
  });
  const database = getDatabaseHandle();
  if (database) void probe(database);
  return () => {
    disposed = true;
    clearRetry();
    stopDatabase();
    stopCredentialMismatch();
    stopDelivery();
    stopOnline();
    foreground.remove();
  };
}
