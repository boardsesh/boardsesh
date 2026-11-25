'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import SessionProviderWrapper, {
  BrowserSessionContext,
  useBrowserSession,
  type BrowserSessionContextValue,
} from '../providers/session-provider';
import AnalyticsIdentity from '../providers/analytics-identity';
import AnalyticsClient from '../analytics-client';
import AdPixelsClient from '../ad-pixels-client';
import { setAnalyticsFlagAccountId } from '@/app/lib/analytics';
import { browserSessionGuard, sessionViewerKey, sessionViewerOf } from '@/app/lib/auth/session-guard';
import { clearMarketingSession, publishMarketingSession } from './marketing-session-store';
import { clearMarketingViewerState } from './marketing-viewer-cleanup';

function SessionBridge() {
  const accepted = useBrowserSession();
  const previousOwner = useRef<{ key: string; signedIn: boolean } | undefined>(undefined);
  const [ConsentSync, setConsentSync] = useState<React.ComponentType | null>(null);
  useLayoutEffect(() => {
    publishMarketingSession(accepted);
    if (accepted.status !== 'loading') {
      setAnalyticsFlagAccountId(accepted.data?.user.id ?? null);
      const nextOwner = {
        key: sessionViewerKey(sessionViewerOf(accepted.data)),
        signedIn: accepted.status === 'authenticated',
      };
      if (previousOwner.current?.signedIn && previousOwner.current.key !== nextOwner.key)
        void clearMarketingViewerState();
      previousOwner.current = nextOwner;
    }
  }, [accepted]);
  useLayoutEffect(() => browserSessionGuard().registerCleanup(clearMarketingViewerState), []);
  useEffect(() => {
    if (accepted.status !== 'authenticated') return;
    let mounted = true;
    void import('./marketing-consent-sync').then(({ default: Sync }) => {
      if (mounted) setConsentSync(() => Sync);
    });
    return () => {
      mounted = false;
    };
  }, [accepted.status]);
  return accepted.status === 'authenticated' && ConsentSync ? <ConsentSync /> : null;
}

export default function MarketingAccountRuntime({
  enableExpoAuthBridge,
  session,
}: {
  enableExpoAuthBridge?: boolean;
  session: BrowserSessionContextValue;
}) {
  useEffect(() => () => clearMarketingSession(), []);
  return (
    <SessionProviderWrapper
      enableExpoAuthBridge={enableExpoAuthBridge}
      awaitExpoAuthBridge={enableExpoAuthBridge === undefined}
    >
      <SessionBridge />
      {/* Consent and analytics use the same mirrored session render. The inner
          authority may already know a new account before the public tree does. */}
      <BrowserSessionContext.Provider value={session}>
        <AnalyticsIdentity />
        <AnalyticsClient />
        <AdPixelsClient />
      </BrowserSessionContext.Provider>
    </SessionProviderWrapper>
  );
}
