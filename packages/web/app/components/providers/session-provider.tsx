'use client';

import React, { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Session } from 'next-auth';
import { getSession, SessionProvider, useSession } from 'next-auth/react';
import { installNextAuthCookieFetchLock } from '../../lib/auth/nextauth-cookie-fetch-lock';

const EXPO_AUTH_CHANNEL_NAME = 'boardsesh-expo-web-auth-v1';
const NEXT_AUTH_STORAGE_KEY = 'nextauth.message';

function settledSessionIdentity(session: Session | null): string {
  if (!session) return 'anonymous';
  return `${session.user.id}:${session.authSessionId ?? 'pending-login-identity'}`;
}

function isExpoAuthClearMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  const candidate = message as Record<string, unknown>;
  return candidate.type === 'auth-token-cleared' && typeof candidate.sourceId === 'string';
}

function refreshLocalNextAuthSession(): void {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: NEXT_AUTH_STORAGE_KEY,
      newValue: JSON.stringify({
        event: 'session',
        data: { trigger: 'getSession' },
        timestamp: Math.floor(Date.now() / 1000),
      }),
    }),
  );
}

export function ExpoAuthSessionBridge() {
  const { data: session, status } = useSession();
  const broadcastIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    if (status === 'loading') return;
    const identity = settledSessionIdentity(session);
    if (broadcastIdentityRef.current === identity) return;
    broadcastIdentityRef.current = identity;
    void getSession().catch(() => {});
  }, [session, status]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(EXPO_AUTH_CHANNEL_NAME);
    } catch {
      return undefined;
    }

    const handleExpoAuthClear = (event: MessageEvent<unknown>) => {
      if (!isExpoAuthClearMessage(event.data)) return;
      // NextAuth's public update() cannot cross null session boundaries. Its own
      // storage listener always re-reads the HttpOnly cookie and sets local
      // provider state, so deliver the same validated hint in this document.
      // The settled-identity effect above then broadcasts the result to others.
      refreshLocalNextAuthSession();
    };
    channel.addEventListener('message', handleExpoAuthClear);
    return () => {
      channel.removeEventListener('message', handleExpoAuthClear);
      channel.close();
    };
  }, []);

  return null;
}

type SessionProviderWrapperProps = {
  children: ReactNode;
  enableExpoAuthBridge?: boolean;
};

// useLayoutEffect warns on the server; fall back to useEffect there (the install
// no-ops without `window` anyway).
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export default function SessionProviderWrapper({
  children,
  enableExpoAuthBridge = false,
}: SessionProviderWrapperProps) {
  // Install the shared cookie-fetch lock in a layout effect rather than the
  // render body: it mutates globalThis.fetch, which must not happen during
  // render (a Strict-Mode double-render hazard). A parent layout effect still
  // runs before the child SessionProvider's passive session-read effect, so the
  // lock is in place before NextAuth's first cookie fetch. Kept gated on the
  // Expo bridge so the normal web app's global fetch is left untouched.
  useIsomorphicLayoutEffect(() => {
    if (enableExpoAuthBridge) installNextAuthCookieFetchLock();
  }, [enableExpoAuthBridge]);
  return (
    <SessionProvider refetchOnWindowFocus={false} refetchWhenOffline={false}>
      {enableExpoAuthBridge && <ExpoAuthSessionBridge />}
      {children}
    </SessionProvider>
  );
}
