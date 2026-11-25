'use client';

import React, { useLayoutEffect } from 'react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { consentAccountTransport } from '../consent/consent-account-transport';
import MarketingQueryProvider from './marketing-query-provider';
import { publishMarketingConsentTransport, useMarketingSession } from './marketing-session-store';

function ConsentTokenBridge() {
  const { token } = useWsAuthToken();
  const { session } = useMarketingSession();
  useLayoutEffect(() => {
    publishMarketingConsentTransport(token, consentAccountTransport, session);
  }, [token, session]);
  return null;
}
export default function MarketingConsentSync() {
  return (
    <MarketingQueryProvider>
      <ConsentTokenBridge />
    </MarketingQueryProvider>
  );
}
