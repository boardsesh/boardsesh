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
import {
  createConsentSyncCoordinator,
  isAnalyticsGranted,
  isRegionDefaultConsent,
  type AnalyticsConsentChoice,
  type ConsentSyncSnapshot,
} from '@boardsesh/consent';
import {
  getWebConsentRecord,
  isConsentRecordAuthorized,
  isConsentRegionConfirmed,
  writeWebConsent,
  refreshWebConsent,
  subscribeWebConsent,
  setConsentAccountResolved,
} from '@/app/lib/consent';
import { loadPendingConsent, persistPendingConsent } from '@/app/lib/consent-pending-db';
import type { ConsentAccountTransport } from './consent-account-transport';

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
  /**
   * Whether the consent card is on screen, or may still come up on this page
   * because the region lookup has not answered. `ConsentBanner` reports it;
   * true until it has. Lets a bottom-of-screen strip (the climb page's sticky
   * install bar) stay out of the card's way without asking whether an answer is
   * stored: a browser sending Global Privacy Control outside the prompt regions
   * stores none and never sees the card.
   */
  promptShowing: boolean;
  /** For `ConsentBanner` only. */
  reportPromptShowing: (showing: boolean) => void;
  syncFailed: boolean;
  decide: (choice: AnalyticsConsentChoice) => Promise<void>;
  openChoices: () => void;
  closeChoices: () => void;
};
const ConsentContext = createContext<ConsentContextValue | null>(null);
export type ConsentAccountState = {
  accountId: string | null;
  token: string | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
};

export function ConsentStateProvider({
  children,
  auth,
  transport,
  onAccountResolved,
}: {
  children: React.ReactNode;
  auth: ConsentAccountState;
  transport?: ConsentAccountTransport;
  onAccountResolved?: (accountId: string | null) => void;
}) {
  const { accountId, token, status } = auth;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [promptShowing, setPromptShowing] = useState(true);
  const [syncFailed, setSyncFailed] = useState(false);
  const authRef = useRef({ ...auth, transport });
  authRef.current = { ...auth, transport };
  const authorityActiveRef = useRef(false);
  const [coordinator] = useState(() =>
    createConsentSyncCoordinator({
      initialRecord: getWebConsentRecord(),
      readAccountConsent: async (accountId) => {
        if (authRef.current.accountId !== accountId || !authRef.current.token || !authRef.current.transport)
          throw new Error('Consent account token is not ready');
        const result = await authRef.current.transport.read(authRef.current.token);
        // Another origin may have withdrawn while this request was in flight.
        // Publish that cookie before the coordinator merges the delayed answer.
        refreshWebConsent();
        return result;
      },
      writeAccountConsent: async (accountId, input) => {
        if (authRef.current.accountId !== accountId || !authRef.current.token || !authRef.current.transport)
          throw new Error('Consent account token is not ready');
        const result = await authRef.current.transport.write(authRef.current.token, input);
        refreshWebConsent();
        return result;
      },
      persistLocalConsent: writeWebConsent,
      loadPendingDecision: loadPendingConsent,
      persistPendingDecision: persistPendingConsent,
      onError: () => setSyncFailed(true),
    }),
  );
  const snapshot = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, () => SERVER_SNAPSHOT);
  const accountReady = status !== 'loading' && accountId === coordinator.getAccountId() && snapshot.accountResolved;
  // A region default counts only once this page load's region lookup confirmed it.
  const regionConfirmed = useSyncExternalStore(subscribeWebConsent, isConsentRegionConfirmed, () => false);
  const analyticsAuthorized =
    accountReady &&
    isAnalyticsGranted(snapshot.record) &&
    (!isRegionDefaultConsent(snapshot.record) || regionConfirmed);
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
    onAccountResolved?.(accountId);
    if (accountId && token) {
      setSyncFailed(false);
      void coordinator.sync();
    }
  }, [accountId, status, token, transport, coordinator, onAccountResolved]);
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
          isConsentRecordAuthorized(coordinator.getSnapshot().record),
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
  const reportPromptShowing = useCallback((showing: boolean) => setPromptShowing(showing), []);
  const context = useMemo(
    () => ({
      snapshot,
      granted: analyticsAuthorized,
      dialogOpen,
      promptShowing,
      reportPromptShowing,
      syncFailed,
      decide,
      openChoices,
      closeChoices,
    }),
    [
      snapshot,
      analyticsAuthorized,
      dialogOpen,
      promptShowing,
      reportPromptShowing,
      syncFailed,
      decide,
      openChoices,
      closeChoices,
    ],
  );
  return <ConsentContext.Provider value={context}>{children}</ConsentContext.Provider>;
}
export function useConsent(): ConsentContextValue {
  const context = useContext(ConsentContext);
  if (!context) throw new Error('ConsentProvider is required');
  return context;
}
