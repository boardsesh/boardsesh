import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { useProfile } from '../../lib/graphql/hooks';
import { usePrivacySettings } from '../../lib/graphql/hooks/use-privacy';
import { getWsClient } from '../../lib/graphql/ws-client';
import {
  getPrivacyCredentialGeneration,
  invalidatePrivacyQueries,
  registerPrivacyRevalidation,
} from '../../lib/privacy/privacy-cache';
import { clearSprayWallPrivateCaches } from '../../lib/spray/spray-privacy-cleanup';
import {
  PrivacyRevalidationDeferredError,
  requirePrivacyRevalidation,
  revalidatePrivateCatalog,
} from '../../offline/privacy-revalidation';
import { canReadPrivateCatalog, subscribeCatalogCredentialMismatch } from '../../offline/catalog-access';
import { getDatabaseHandle, subscribeDatabaseHandle } from '../../db/connection';
import { clearStoredSprayPhotos } from '../../lib/spray/spray-photo-store';
import { reportHandledError } from '../../lib/error-reporting';

/** A reconnect gets an immediate signal, covering revocations missed offline. */
export function PrivacySyncBridge() {
  const queryClient = useQueryClient();
  const { data: profile } = useProfile();
  const { data: privacy } = usePrivacySettings();
  const [supported, setSupported] = useState(false);
  const viewerRef = useRef(profile?.id);
  viewerRef.current = profile?.id;
  useEffect(() => {
    if (privacy) setSupported(true);
  }, [privacy]);
  useEffect(() => {
    if (!supported || !profile?.id) return;
    const viewerId = profile.id;
    let disposed = false;
    let revision = 0;
    let dirty = false;
    let running = false;
    let retryIndex = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retryDelays = [1_000, 5_000, 15_000];
    const clearRetry = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const currentViewer = () => !disposed && viewerRef.current === viewerId;
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
        await revalidatePrivateCatalog(database, viewerId, isCurrent, canAuthorize);
        if (isCurrent()) retryIndex = 0;
      } catch (error) {
        if (currentViewer() && revision === attemptRevision) {
          dirty = true;
          if (!(error instanceof PrivacyRevalidationDeferredError)) {
            reportHandledError(error, { tags: { source: 'privacy-revalidation' } });
          }
          const delay = canAuthorize() ? retryDelays[retryIndex++] : undefined;
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
      if (!currentViewer() || revision === 0) return;
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
    const revokeSnapshots = () => {
      if (!currentViewer()) return;
      void invalidatePrivacyQueries(queryClient).catch((error: unknown) => {
        reportHandledError(error, { tags: { source: 'privacy-revocation' } });
      });
    };
    const stopCredentialMismatch = subscribeCatalogCredentialMismatch(revokeSnapshots);
    // Local reads may beat profile/privacy readiness. Probe again after installing
    // the listener so a refresh mismatch observed during startup cannot be lost.
    const database = getDatabaseHandle();
    if (database) void canReadPrivateCatalog(database);
    const unsubscribe = getWsClient().subscribe<{ privacyChanged: boolean }>(
      { query: 'subscription PrivacyChanged { privacyChanged }' },
      {
        next: revokeSnapshots,
        // A lost privacy stream invalidates displayed protected material too.
        error: revokeSnapshots,
        complete: () => {},
      },
    );
    return () => {
      disposed = true;
      clearRetry();
      stopDatabase();
      stopCredentialMismatch();
      stopOnline();
      foreground.remove();
      unregister();
      unsubscribe();
    };
  }, [supported, profile?.id, queryClient]);
  return null;
}
