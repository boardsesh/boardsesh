'use client';

import React, { useEffect, useState } from 'react';
import { ConsentStateProvider } from '../consent/consent-state-provider';
import { useMarketingSession } from './marketing-session-store';
import type { BrowserSessionContextValue } from '../providers/session-provider';

/** Public content and consent controls render without account/query application wiring. */
export function MarketingRuntime({
  children,
  enableExpoAuthBridge = false,
}: {
  children: React.ReactNode;
  enableExpoAuthBridge?: boolean;
}) {
  const { session, token, transport } = useMarketingSession();
  const [AccountRuntime, setAccountRuntime] = useState<React.ComponentType<{
    enableExpoAuthBridge?: boolean;
    session: BrowserSessionContextValue;
  }> | null>(null);
  useEffect(() => {
    let mounted = true;
    void import('./marketing-account-runtime').then(({ default: Runtime }) => {
      if (mounted) setAccountRuntime(() => Runtime);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return (
    <ConsentStateProvider
      auth={{ accountId: session.data?.user.id ?? null, status: session.status, token }}
      transport={transport}
    >
      {children}
      {AccountRuntime ? <AccountRuntime enableExpoAuthBridge={enableExpoAuthBridge} session={session} /> : null}
    </ConsentStateProvider>
  );
}
