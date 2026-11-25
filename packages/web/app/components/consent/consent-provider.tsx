'use client';

import React from 'react';
import { useSession } from 'next-auth/react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { setAnalyticsFlagAccountId } from '@/app/lib/analytics';
import { consentAccountTransport } from './consent-account-transport';
import { ConsentStateProvider } from './consent-state-provider';

export { useConsent } from './consent-state-provider';

/** Application routes retain their existing guarded session/query providers. */
export function ConsentProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const { token } = useWsAuthToken(status === 'authenticated');
  return (
    <ConsentStateProvider
      auth={{ accountId: session?.user.id ?? null, token, status }}
      transport={consentAccountTransport}
      onAccountResolved={setAnalyticsFlagAccountId}
    >
      {children}
    </ConsentStateProvider>
  );
}
