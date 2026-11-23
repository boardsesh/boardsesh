import { AppState } from 'react-native';
import type { OfflineDatabase } from '@boardsesh/offline-sync';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../lib/auth-store';
import { getConnectivitySnapshot, subscribeConnectivity } from '../lib/connectivity/connectivity-store';
import { readSignedInAccount } from './offline-sync-adapter';
import { subscribeOutbox } from './outbox-store';
import { publishOfflineWriteDelivery } from './offline-write-delivery';
import { hasOfflineWriteLocalProof } from './offline-write-local-proof';
import { readOfflineWriteRelease } from './offline-write-context';
import { offlineWriteFetch } from './offline-write-transport';

/** Independent, bounded publication; no per-row requests and no retry budget charges. */
export function startOfflineWriteDeliveryPublisher(db: OfflineDatabase): () => void {
  let stopped = false;
  let foreground = AppState.currentState == null || AppState.currentState === 'active';
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const publish = async () => {
    if (stopped || !foreground || getConnectivitySnapshot().effectiveOffline) return;
    const generation = captureAuthCredentialGeneration();
    const current = () =>
      !stopped &&
      foreground &&
      isAuthCredentialGenerationCurrent(generation) &&
      !getConnectivitySnapshot().effectiveOffline;
    const account = await readSignedInAccount();
    if (account.status !== 'signed-in' || !current()) return;
    await publishOfflineWriteDelivery(db, offlineWriteFetch, {
      ownerUserId: account.userId,
      isCurrent: current,
      observedRelease: readOfflineWriteRelease(),
      verifyLocalState: (candidate) => hasOfflineWriteLocalProof(db, candidate, account.userId),
    });
  };
  const schedule = () => {
    if (stopped || scheduled !== undefined) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      void publish().catch((error: unknown) => {
        if (__DEV__) console.warn('[OfflineWriteDelivery] publication deferred', error);
      });
    }, 500);
  };
  const connectivity = subscribeConnectivity(schedule);
  const outbox = subscribeOutbox(schedule);
  const state = AppState.addEventListener('change', (nextState) => {
    foreground = nextState === 'active';
    if (foreground) schedule();
  });
  const heartbeat = setInterval(schedule, 60_000);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(scheduled);
    clearInterval(heartbeat);
    connectivity();
    outbox();
    state.remove();
  };
}
