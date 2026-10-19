import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import {
  createConsentSyncCoordinator,
  createRegionDefaultConsent,
  isRegionDefaultConsent,
  needsPrompt,
  type AnalyticsConsentChoice,
  type ConsentSource,
} from '@boardsesh/consent';
import { getConsentSnapshot, subscribeConsent, updateConsentState } from '../lib/consent-state';
import {
  readLocalConsent,
  persistLocalConsent,
  readPendingConsent,
  persistPendingConsent,
  readLatestExternalConsent,
} from '../lib/consent-storage';
import '../lib/consent-auth-invalidation';
import { captureAuthCredentialGeneration, getAuthToken, isAuthCredentialGenerationCurrent } from '../lib/auth-store';
import { readLocalUserId } from '../lib/local-user-id';
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
  if (!current()) throw new Error('Consent account was superseded');
  if (!token) throw new Error('Consent credential is missing');
  // Fence native JWT and confirmed browser identities locally; the backend authenticates the credential.
  const credentialOwner = await readLocalUserId(token);
  if (!current() || credentialOwner !== accountId) throw new Error('Consent credential owner changed');
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

/**
 * Outside the prompt regions a device with no answer starts with analytics on.
 * The default stays on this device: the coordinator never writes it to an
 * account, and an account denial still replaces it. No-op once the device has
 * any answer, so it can never overwrite a choice.
 */
export function applyRegionDefaultConsent(source: ConsentSource): void {
  if (!coordinator || !needsPrompt(coordinator.getSnapshot().record)) return;
  const record = createRegionDefaultConsent(source);
  // Persist first: on the browser app this writes the shared cookie
  // synchronously, so a capture-time cookie read already sees the default.
  void persistLocalConsent(record).catch((error) => reportHandledError(error));
  coordinator.replaceLocalRecord(record);
}

/**
 * Drop a region default when this launch is in a prompt region (a climber who
 * travelled into the EU, say), so the prompt asks. Leaves any explicit answer.
 */
export function clearRegionDefaultConsent(): void {
  if (!coordinator || !isRegionDefaultConsent(coordinator.getSnapshot().record)) return;
  void persistLocalConsent(null).catch((error) => reportHandledError(error));
  coordinator.replaceLocalRecord(null);
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
