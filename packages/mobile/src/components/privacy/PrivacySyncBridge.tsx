import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { useProfile } from '../../lib/graphql/hooks';
import { usePrivacySettings } from '../../lib/graphql/hooks/use-privacy';
import { getWsClient } from '../../lib/graphql/ws-client';
import { selectOfflineMode, useConnectivityField } from '../../lib/connectivity/use-connectivity';
import { useAuthTransportRevision } from '../../lib/auth-transport-revision';
import {
  getPrivacyCredentialGeneration,
  invalidatePrivacyQueries,
  registerPrivacyRevalidation,
} from '../../lib/privacy/privacy-cache';
import { clearSprayWallPrivateCaches } from '../../lib/spray/spray-privacy-cleanup';
import {
  PrivacyRevalidationDeferredError,
  requirePrivacyRevalidation,
  persistCatalogWithdrawal,
  needsCatalogOutboxRepair,
  revalidatePrivateCatalog,
} from '../../offline/privacy-revalidation';
import { getAuthorizedCatalogViewerId, subscribeCatalogCredentialMismatch } from '../../offline/catalog-access';
import { getDatabaseHandle, subscribeDatabaseHandle } from '../../db/connection';
import { clearStoredSprayPhotos } from '../../lib/spray/spray-photo-store';
import { reportHandledError } from '../../lib/error-reporting';
import { subscribeMutationDelivery } from '../../offline/offline-sync-adapter';

const PRIVACY_RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

/** A reconnect gets an immediate signal, covering revocations missed offline. */
export function PrivacySyncBridge() {
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const { data: privacy } = usePrivacySettings();
  const offlineMode = useConnectivityField(selectOfflineMode);
  const authTransportRevision = useAuthTransportRevision();
  const pendingConnectionRef = useRef(false);
  const connectionRevalidationRef = useRef<(() => boolean) | null>(null);
  const [supported, setSupported] = useState(false);
  const viewerRef = useRef(profile?.id);
  viewerRef.current = profile?.id;
  useEffect(() => {
    if (privacy) setSupported(true);
  }, [privacy]);
  // Watch from mount: profile/privacy queries may finish after the socket's
  // first connection. Persist its withdrawal before handing off authorization.
  useEffect(() => {
    let disposed = false;
    let withdrawalPending = pendingConnectionRef.current;
    let withdrawalRunning = false;
    let withdrawalRevision = 0;
    let withdrawalRetryIndex = 0;
    let withdrawalTimer: ReturnType<typeof setTimeout> | undefined;
    const installedViewer = profile?.id;
    const clearWithdrawalRetry = () => {
      clearTimeout(withdrawalTimer);
      withdrawalTimer = undefined;
    };
    const foregrounded = () => AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
    const persistPendingWithdrawal = () => {
      if (!pendingConnectionRef.current) {
        withdrawalPending = false;
        clearWithdrawalRetry();
        return;
      }
      if (disposed || !withdrawalPending || withdrawalRunning) return;
      const database = getDatabaseHandle();
      if (!database) return;
      const attemptRevision = withdrawalRevision;
      const credentialGeneration = getPrivacyCredentialGeneration();
      const current = () =>
        !disposed &&
        viewerRef.current === installedViewer &&
        getDatabaseHandle() === database &&
        getPrivacyCredentialGeneration() === credentialGeneration;
      withdrawalPending = false;
      withdrawalRunning = true;
      let failed = false;
      void persistCatalogWithdrawal(database, current)
        .then(() => {
          if (current()) withdrawalRetryIndex = 0;
        })
        .catch((error: unknown) => {
          if (current() && pendingConnectionRef.current && withdrawalRevision === attemptRevision) {
            failed = true;
            withdrawalPending = true;
            reportHandledError(error, { tags: { source: 'privacy-withdrawal' } });
          }
        })
        .finally(() => {
          withdrawalRunning = false;
          if (disposed || !withdrawalPending) return;
          // A later event or replacement handle may supersede an in-flight write.
          if (!failed) persistPendingWithdrawal();
          else if (current() && foregrounded() && pendingConnectionRef.current) {
            const delay = PRIVACY_RETRY_DELAYS_MS[withdrawalRetryIndex++];
            if (delay !== undefined)
              withdrawalTimer = setTimeout(() => {
                withdrawalTimer = undefined;
                if (current() && foregrounded() && withdrawalRevision === attemptRevision) persistPendingWithdrawal();
              }, delay);
          }
        });
    };
    const resumeWithdrawal = () => {
      if (!pendingConnectionRef.current || disposed) return;
      withdrawalRevision += 1;
      withdrawalPending = true;
      withdrawalRetryIndex = 0;
      clearWithdrawalRetry();
      persistPendingWithdrawal();
    };
    const foreground = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || disposed || !withdrawalPending || !pendingConnectionRef.current) return;
      withdrawalRetryIndex = 0;
      clearWithdrawalRetry();
      persistPendingWithdrawal();
    });
    const stopDatabase = subscribeDatabaseHandle(resumeWithdrawal);
    const stopConnected = offlineMode
      ? undefined
      : getWsClient().on('connected', () => {
          if (disposed) return;
          pendingConnectionRef.current = true;
          if (connectionRevalidationRef.current?.()) {
            pendingConnectionRef.current = false;
            withdrawalPending = false;
            clearWithdrawalRetry();
            return;
          }
          clearSprayWallPrivateCaches();
          clearStoredSprayPhotos();
          requirePrivacyRevalidation();
          withdrawalRevision += 1;
          withdrawalPending = true;
          withdrawalRetryIndex = 0;
          clearWithdrawalRetry();
          persistPendingWithdrawal();
          void invalidatePrivacyQueries(queryClient, () => Promise.resolve()).catch((error: unknown) => {
            reportHandledError(error, { tags: { source: 'privacy-revocation' } });
          });
        });
    persistPendingWithdrawal();
    return () => {
      disposed = true;
      clearWithdrawalRetry();
      foreground.remove();
      stopDatabase();
      stopConnected?.();
    };
  }, [offlineMode, authTransportRevision, profile?.id, queryClient]);
  useEffect(() => {
    if (!supported || !profile?.id) return;
    const viewerId = profile.id;
    let disposed = false;
    let revision = 0;
    let dirty = false;
    let running = false;
    let retryIndex = 0;
    let deliveryRevision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearRetry = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const currentViewer = () => !disposed && viewerRef.current === viewerId;
    const canAuthorize = () =>
      !offlineMode &&
      onlineManager.isOnline() &&
      AppState.currentState !== 'background' &&
      AppState.currentState !== 'inactive';
    const repair = async (persistWithdrawal = false): Promise<void> => {
      if (running || !dirty || !currentViewer() || (!persistWithdrawal && !canAuthorize())) return;
      const database = getDatabaseHandle();
      if (!database) return; // A published handle will resume this same withdrawal.
      running = true;
      dirty = false;
      const attemptRevision = revision;
      const attemptDeliveryRevision = deliveryRevision;
      const credentialGeneration = getPrivacyCredentialGeneration();
      const isCurrent = () =>
        currentViewer() &&
        revision === attemptRevision &&
        getDatabaseHandle() === database &&
        getPrivacyCredentialGeneration() === credentialGeneration;
      try {
        await revalidatePrivateCatalog(database, viewerId, isCurrent, canAuthorize);
        if (isCurrent()) retryIndex = 0;
      } catch (error) {
        if (currentViewer() && revision === attemptRevision) {
          dirty = true;
          if (!(error instanceof PrivacyRevalidationDeferredError)) {
            reportHandledError(error, { tags: { source: 'privacy-revalidation' } });
          }
          const delay = canAuthorize() ? PRIVACY_RETRY_DELAYS_MS[retryIndex++] : undefined;
          if (delay !== undefined)
            timer = setTimeout(() => {
              timer = undefined;
              void repair();
            }, delay);
        }
      } finally {
        running = false;
        // An event received during a repair must run once more; sharing the old
        // promise would silently authorize the catalogue for the older event.
        if (currentViewer() && revision !== attemptRevision) void repair(true);
        else if (
          currentViewer() &&
          deliveryRevision !== attemptDeliveryRevision &&
          needsCatalogOutboxRepair(viewerId)
        ) {
          // Delivery can land before this attempt first marks the cleanup as
          // blocked. Retry after it settles instead of losing that acknowledgment.
          dirty = true;
          clearRetry();
          timer = setTimeout(() => {
            timer = undefined;
            void repair();
          }, 1_000);
        }
      }
    };
    const unregister = registerPrivacyRevalidation(() => {
      if (!currentViewer()) return Promise.resolve();
      clearSprayWallPrivateCaches();
      clearStoredSprayPhotos();
      requirePrivacyRevalidation();
      revision += 1;
      dirty = true;
      retryIndex = 0;
      clearRetry();
      return repair(true);
    });
    const resume = () => {
      if (!dirty || !currentViewer()) return;
      retryIndex = 0;
      clearRetry();
      void repair();
    };
    const stopDatabase = subscribeDatabaseHandle(() => {
      if (!currentViewer()) return;
      if (revision === 0) {
        void checkViewerMarker(getDatabaseHandle());
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
    // A preserved queued write closes local reads without failing authorization.
    // Once it is delivered, retry the cleanup. Coalesce a drain's acknowledgments
    // and keep the existing foreground/connection and single-flight gates.
    const stopMutationDelivery = subscribeMutationDelivery((event) => {
      if (event.status !== 'acknowledged' || !currentViewer()) return;
      deliveryRevision += 1;
      if (running || !needsCatalogOutboxRepair(viewerId)) return;
      dirty = true;
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (needsCatalogOutboxRepair(viewerId)) void repair();
        else dirty = false;
      }, 1_000);
    });
    const stopOnline = onlineManager.subscribe((online) => {
      if (online) resume();
    });
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') resume();
    });
    const revokeSnapshots = (): boolean => {
      if (!currentViewer()) return false;
      void invalidatePrivacyQueries(queryClient).catch((error: unknown) => {
        reportHandledError(error, { tags: { source: 'privacy-revocation' } });
      });
      return true;
    };
    const stopCredentialMismatch = subscribeCatalogCredentialMismatch(revokeSnapshots);
    async function checkViewerMarker(database: ReturnType<typeof getDatabaseHandle>): Promise<void> {
      if (!database || !currentViewer() || revision !== 0) return;
      const markerRevision = revision;
      const credentialGeneration = getPrivacyCredentialGeneration();
      const authorizedViewer = await getAuthorizedCatalogViewerId(database);
      if (
        !currentViewer() ||
        getDatabaseHandle() !== database ||
        getPrivacyCredentialGeneration() !== credentialGeneration ||
        revision !== markerRevision
      )
        return;
      // Missing, malformed and other-viewer markers all need a server check.
      // A digest mismatch may already have notified the listener above; the
      // revision guard avoids requesting that same withdrawal twice.
      if (authorizedViewer !== viewerId) revokeSnapshots();
    }
    connectionRevalidationRef.current = revokeSnapshots;
    if (pendingConnectionRef.current && revokeSnapshots()) pendingConnectionRef.current = false;
    // Keep the server's first yield until shipped clients adopt these triggers.
    // Mode and auth transport revisions rebind a replaced singleton.
    const wsClient = offlineMode ? undefined : getWsClient();
    const unsubscribe = wsClient?.subscribe<{ privacyChanged: boolean }>(
      { query: 'subscription PrivacyChanged { privacyChanged }' },
      {
        next: revokeSnapshots,
        // A lost privacy stream invalidates displayed protected material too.
        error: revokeSnapshots,
        complete: () => {},
      },
    );
    // Profile/privacy and schema readiness can arrive in either order. A
    // published handle repeats this probe when mount had no usable database.
    void checkViewerMarker(getDatabaseHandle());
    return () => {
      disposed = true;
      clearRetry();
      stopDatabase();
      stopCredentialMismatch();
      stopOnline();
      stopMutationDelivery();
      foreground.remove();
      unregister();
      if (connectionRevalidationRef.current === revokeSnapshots) connectionRevalidationRef.current = null;
      unsubscribe?.();
    };
  }, [supported, profile?.id, queryClient, offlineMode, authTransportRevision]);
  return null;
}
