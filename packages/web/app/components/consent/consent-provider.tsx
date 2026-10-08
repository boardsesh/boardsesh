'use client';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useSession } from 'next-auth/react';
import {
  createConsentSyncCoordinator,
  isAnalyticsGranted,
  type AnalyticsConsentChoice,
  type ConsentSyncSnapshot,
} from '@boardsesh/consent';
import {
  GET_MY_ANALYTICS_CONSENT,
  SET_ANALYTICS_CONSENT,
  type GetMyAnalyticsConsentResponse,
  type SetAnalyticsConsentResponse,
} from '@boardsesh/graphql/operations/analytics-consent';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { executeGraphQL } from '@/app/lib/graphql/client';
import {
  getWebConsentRecord,
  writeWebConsent,
  refreshWebConsent,
  subscribeWebConsent,
  setConsentAccountResolved,
} from '@/app/lib/consent';
import { loadPendingConsent, persistPendingConsent } from '@/app/lib/consent-pending-db';
import { setAnalyticsFlagAccountId } from '@/app/lib/analytics';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const SERVER_SNAPSHOT: ConsentSyncSnapshot = {
  record: null,
  ready: true,
  syncing: false,
  accountResolved: false,
  pending: false,
};
type ConsentContextValue = {
  snapshot: ConsentSyncSnapshot;
  granted: boolean;
  dialogOpen: boolean;
  syncFailed: boolean;
  decide: (choice: AnalyticsConsentChoice) => Promise<void>;
  openChoices: () => void;
  closeChoices: () => void;
};
const ConsentContext = createContext<ConsentContextValue | null>(null);
export function ConsentProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const { token } = useWsAuthToken(status === 'authenticated');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);
  const authRef = useRef({ accountId: session?.user.id ?? null, token, status });
  authRef.current = { accountId: session?.user.id ?? null, token, status };
  const authorityActiveRef = useRef(false);
  const [coordinator] = useState(() =>
    createConsentSyncCoordinator({
      initialRecord: getWebConsentRecord(),
      readAccountConsent: async (accountId) => {
        if (authRef.current.accountId !== accountId || !authRef.current.token)
          throw new Error('Consent account token is not ready');
        const result = await executeGraphQL<GetMyAnalyticsConsentResponse>(
          GET_MY_ANALYTICS_CONSENT,
          undefined,
          authRef.current.token,
        );
        // Another origin may have withdrawn while this request was in flight.
        // Publish that cookie before the coordinator merges the delayed answer.
        refreshWebConsent();
        return result.myAnalyticsConsent;
      },
      writeAccountConsent: async (accountId, input) => {
        if (authRef.current.accountId !== accountId || !authRef.current.token)
          throw new Error('Consent account token is not ready');
        const result = await executeGraphQL<SetAnalyticsConsentResponse>(
          SET_ANALYTICS_CONSENT,
          { input },
          authRef.current.token,
        );
        refreshWebConsent();
        return result.setAnalyticsConsent;
      },
      persistLocalConsent: writeWebConsent,
      loadPendingDecision: loadPendingConsent,
      persistPendingDecision: persistPendingConsent,
      onError: () => setSyncFailed(true),
    }),
  );
  const snapshot = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, () => SERVER_SNAPSHOT);
  const accountId = status === 'authenticated' ? (session?.user.id ?? null) : null;
  const accountReady = status !== 'loading' && accountId === coordinator.getAccountId() && snapshot.accountResolved;
  const analyticsAuthorized = accountReady && isAnalyticsGranted(snapshot.record);
  useIsomorphicLayoutEffect(() => {
    authorityActiveRef.current = true;
    setConsentAccountResolved(analyticsAuthorized);
    return () => {
      authorityActiveRef.current = false;
      setConsentAccountResolved(false);
    };
  }, [analyticsAuthorized]);
  useEffect(() => {
    if (status === 'loading') return;
    coordinator.setAccount(accountId);
    setAnalyticsFlagAccountId(accountId);
    if (accountId && token) {
      setSyncFailed(false);
      void coordinator.sync();
    }
  }, [accountId, status, token, coordinator]);
  useEffect(() => {
    const updateCookie = () => {
      coordinator.replaceLocalRecord(getWebConsentRecord());
      // A signed-out grant has no account query to finish and may leave the
      // layout-effect dependencies unchanged. Restore its gate synchronously.
      const auth = authRef.current;
      setConsentAccountResolved(
        authorityActiveRef.current &&
          auth.status !== 'loading' &&
          auth.accountId === coordinator.getAccountId() &&
          coordinator.getSnapshot().accountResolved &&
          isAnalyticsGranted(coordinator.getSnapshot().record),
      );
    };
    const unsubscribe = subscribeWebConsent(updateCookie);
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      refreshWebConsent();
      if (authRef.current.accountId && authRef.current.token) {
        setSyncFailed(false);
        void coordinator.sync();
      }
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [coordinator]);
  const decide = useCallback(
    async (choice: AnalyticsConsentChoice) => {
      setSyncFailed(false);
      await coordinator.decide(choice, 'web');
    },
    [coordinator],
  );
  const openChoices = useCallback(() => setDialogOpen(true), []);
  const closeChoices = useCallback(() => setDialogOpen(false), []);
  const context = useMemo(
    () => ({
      snapshot,
      granted: analyticsAuthorized,
      dialogOpen,
      syncFailed,
      decide,
      openChoices,
      closeChoices,
    }),
    [snapshot, analyticsAuthorized, dialogOpen, syncFailed, decide, openChoices, closeChoices],
  );
  return <ConsentContext.Provider value={context}>{children}</ConsentContext.Provider>;
}
export function useConsent(): ConsentContextValue {
  const context = useContext(ConsentContext);
  if (!context) throw new Error('ConsentProvider is required');
  return context;
}
