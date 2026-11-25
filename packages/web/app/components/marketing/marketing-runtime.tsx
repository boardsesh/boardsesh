'use client';

import React, { useEffect, useState } from 'react';
import { ConsentStateProvider } from '../consent/consent-state-provider';
import { useMarketingSession } from './marketing-session-store';
import type { BrowserSessionContextValue } from '../providers/session-provider';
import {
  parseMarketingRuntimeCapabilities,
  type MarketingRuntimeCapabilities,
} from '@/app/lib/marketing-runtime-capabilities';
import { MarketingCapabilitiesContext } from './marketing-capabilities-context';

function useRuntimeCapabilities() {
  const [capabilities, setCapabilities] = useState<MarketingRuntimeCapabilities | null>(null);
  useEffect(() => {
    let mounted = true;
    let suspended = document.visibilityState === 'hidden';
    let activeRequest: { cancel: () => void } | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const refresh = async () => {
      if (!mounted || suspended || activeRequest) return;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const controller = new AbortController();
      attempts += 1;
      const request = { cancel: () => controller.abort() };
      activeRequest = request;
      let deadline: ReturnType<typeof setTimeout> | null = null;
      const ownsResult = () => mounted && !suspended && activeRequest === request;
      try {
        const payload: unknown = await Promise.race([
          fetch('/api/health', {
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            signal: controller.signal,
          }).then((response) => {
            if (!response.ok) throw new Error('Runtime capabilities unavailable');
            return response.json() as Promise<unknown>;
          }),
          new Promise<never>((_resolve, reject) => {
            request.cancel = () => {
              controller.abort();
              reject(new Error('Runtime capabilities unavailable'));
            };
            deadline = setTimeout(request.cancel, 10_000);
          }),
        ]);
        const nextCapabilities = parseMarketingRuntimeCapabilities(
          typeof payload === 'object' && payload !== null && 'marketing' in payload ? payload.marketing : null,
        );
        if (!nextCapabilities) throw new Error('Invalid runtime capabilities');
        if (ownsResult() && !controller.signal.aborted) {
          setCapabilities(nextCapabilities);
        }
      } catch {
        if (ownsResult() && attempts < 3) {
          retryTimer = setTimeout(
            () => {
              retryTimer = null;
              void refresh();
            },
            1000 * 2 ** (attempts - 1),
          );
        }
      } finally {
        if (deadline !== null) clearTimeout(deadline);
        if (activeRequest === request) activeRequest = null;
      }
    };
    const refreshOnReturn = () => {
      attempts = 0;
      void refresh();
    };
    const pageHide = () => {
      suspended = true;
      activeRequest?.cancel();
      activeRequest = null;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    };
    const pageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      suspended = false;
      refreshOnReturn();
    };
    const visibilityChange = () => {
      if (document.visibilityState === 'hidden') pageHide();
      else {
        suspended = false;
        refreshOnReturn();
      }
    };
    void refresh();
    window.addEventListener('online', refreshOnReturn);
    window.addEventListener('focus', refreshOnReturn);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', pageShow);
    document.addEventListener('visibilitychange', visibilityChange);
    return () => {
      mounted = false;
      activeRequest?.cancel();
      if (retryTimer !== null) clearTimeout(retryTimer);
      window.removeEventListener('online', refreshOnReturn);
      window.removeEventListener('focus', refreshOnReturn);
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
      document.removeEventListener('visibilitychange', visibilityChange);
    };
  }, []);
  return capabilities;
}

/** Public content and consent controls render without account/query application wiring. */
export function MarketingRuntime({ children }: { children: React.ReactNode }) {
  const capabilities = useRuntimeCapabilities();
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
    <MarketingCapabilitiesContext.Provider value={capabilities}>
      <ConsentStateProvider
        auth={{ accountId: session.data?.user.id ?? null, status: session.status, token }}
        transport={transport}
      >
        {children}
        {AccountRuntime ? (
          <AccountRuntime enableExpoAuthBridge={capabilities?.enableExpoAuthBridge} session={session} />
        ) : null}
      </ConsentStateProvider>
    </MarketingCapabilitiesContext.Provider>
  );
}
