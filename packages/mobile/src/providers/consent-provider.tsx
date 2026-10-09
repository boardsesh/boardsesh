import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { createConsentSyncCoordinator, type AnalyticsConsentChoice, type ConsentSource } from '@boardsesh/consent';
import {
  getConsentSnapshot,
  subscribeConsent,
  updateConsentState,
  isProductAnalyticsGranted,
} from '../lib/consent-state';
import {
  readLocalConsent,
  persistLocalConsent,
  readPendingConsent,
  persistPendingConsent,
  readLatestExternalConsent,
} from '../lib/consent-storage';
import '../lib/consent-auth-invalidation';
import { captureAuthCredentialGeneration, getAuthToken, isAuthCredentialGenerationCurrent } from '../lib/auth-store';
import { userIdFromJwt } from '../lib/jwt-user-id';
import { initializePosthogClient, applyPosthogConsent } from '../lib/posthog-client';
import { getHttpClient } from '../lib/graphql/client';
import {
  GET_MY_ANALYTICS_CONSENT,
  SET_ANALYTICS_CONSENT,
  type GetMyAnalyticsConsentResponse,
  type SetAnalyticsConsentResponse,
} from '@boardsesh/graphql/operations/analytics-consent';
import { reportHandledError } from '../lib/error-reporting';
import { ConsentSettledContext } from '../lib/consent-hooks';
import { configureObserve } from '../lib/observe-runtime';
export { useConsentSettled, useAnalyticsConsent } from '../lib/consent-hooks';

let coordinator: ReturnType<typeof createConsentSyncCoordinator> | null = null;
let loading: Promise<void> | null = null;

// Stop outbound SDK work in the decision's synchronous call stack, before React effects run.
subscribeConsent(() => {
  if (!getConsentSnapshot().authSettled) coordinator?.setAccount(null);
  coordinator?.replaceLocalRecord(getConsentSnapshot().record);
  if (coordinator && coordinator.getSnapshot().record !== getConsentSnapshot().record) {
    const authoritative = coordinator.getSnapshot();
    updateConsentState({
      record: authoritative.record,
      accountResolved: authoritative.accountResolved && !authoritative.syncing,
    });
  }
  if (!isProductAnalyticsGranted()) configureObserve({ dispatchingEnabled: false, sampleRate: 0 });
  void applyPosthogConsent().catch((error) => reportHandledError(error));
  void initializePosthogClient().catch((error) => reportHandledError(error));
});

export function getConsentCoordinator() {
  return coordinator;
}

async function withConsentAccount<T>(accountId: string, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const authEpoch = getConsentSnapshot().authEpoch;
  const credentialGeneration = captureAuthCredentialGeneration();
  const current = () =>
    getConsentSnapshot().authSettled &&
    getConsentSnapshot().accountId === accountId &&
    coordinator?.getAccountId() === accountId &&
    getConsentSnapshot().authEpoch === authEpoch &&
    isAuthCredentialGenerationCurrent(credentialGeneration);
  if (!current()) throw new Error('Consent account was superseded');
  const token = await getAuthToken();
  if (!current() || userIdFromJwt(token) !== accountId) throw new Error('Consent credential owner changed');
  const controller = new AbortController();
  const unsubscribe = subscribeConsent(() => {
    if (!current()) controller.abort();
  });
  try {
    const result = await request(controller.signal);
    if (!current()) throw new Error('Consent account was superseded');
    // Another browser subdomain may have withdrawn while this response was in flight.
    coordinator?.replaceLocalRecord(readLatestExternalConsent());
    return result;
  } finally {
    unsubscribe();
  }
}

export async function initializeConsent(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    const record = await readLocalConsent().catch(() => null);
    coordinator = createConsentSyncCoordinator({
      initialRecord: record,
      persistLocalConsent,
      loadPendingDecision: readPendingConsent,
      persistPendingDecision: persistPendingConsent,
      readAccountConsent: (accountId) =>
        withConsentAccount(
          accountId,
          async (signal) =>
            (
              await getHttpClient().request<GetMyAnalyticsConsentResponse>({
                document: GET_MY_ANALYTICS_CONSENT,
                signal,
              })
            ).myAnalyticsConsent,
        ),
      writeAccountConsent: (accountId, input) =>
        withConsentAccount(
          accountId,
          async (signal) =>
            (
              await getHttpClient().request<SetAnalyticsConsentResponse>({
                document: SET_ANALYTICS_CONSENT,
                variables: { input },
                signal,
              })
            ).setAnalyticsConsent,
        ),
      onError: (error) => reportHandledError(error, { tags: { source: 'analytics-consent' } }),
    });
    coordinator.subscribe(() => {
      const account = coordinator!.getSnapshot();
      updateConsentState({ record: account.record, accountResolved: account.accountResolved && !account.syncing });
    });
    updateConsentState({
      record,
      loaded: true,
      accountResolved: coordinator.getSnapshot().accountResolved,
      settled: process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1',
    });
    await initializePosthogClient();
  })();
  return loading;
}

export function decideAnalyticsConsent(choice: AnalyticsConsentChoice, source: ConsentSource): Promise<void> {
  if (!coordinator) return initializeConsent().then(() => decideAnalyticsConsent(choice, source));
  const decided = coordinator!.decide(choice, source);
  // The coordinator publishes the new local answer before doing any network I/O.
  updateConsentState({ settled: true });
  return decided;
}

export function ConsentProvider({ children }: { children: ReactNode }) {
  const consent = useSyncExternalStore(subscribeConsent, getConsentSnapshot, getConsentSnapshot);
  useEffect(() => {
    void initializeConsent().catch((error) => reportHandledError(error));
  }, []);
  useEffect(() => {
    // The SDK does not decide capture eligibility: every caller checks the state synchronously.
    void applyPosthogConsent().catch((error) => reportHandledError(error));
  }, [consent.loaded, consent.record?.analytics, consent.killed]);
  return <ConsentSettledContext.Provider value={consent.settled}>{children}</ConsentSettledContext.Provider>;
}
