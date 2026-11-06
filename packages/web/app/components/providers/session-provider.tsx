'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from 'next-auth';
import { getSession, SessionContext, type SessionContextValue } from 'next-auth/react';
import { installNextAuthCookieFetchLock } from '../../lib/auth/nextauth-cookie-fetch-lock';
import {
  beginWebSessionIntent,
  captureWebSessionEpoch,
  WEB_SESSION_REFRESH_EVENT,
} from '../../lib/auth/web-session-events';

const EXPO_AUTH_CHANNEL_NAME = 'boardsesh-expo-web-auth-v1';
const NEXT_AUTH_STORAGE_KEY = 'nextauth.message';

function isExpoAuthClearMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
  const candidate = message as Record<string, unknown>;
  return candidate.type === 'auth-token-cleared' && typeof candidate.sourceId === 'string';
}

function parseSession(candidate: unknown): Session | null {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
    throw new Error('Invalid session response');
  const session = candidate as Record<string, unknown>;
  if (Object.keys(session).length === 0) return null;
  if (typeof session.user !== 'object' || session.user === null || Array.isArray(session.user))
    throw new Error('Invalid session response');
  const user = session.user as Record<string, unknown>;
  if (typeof user.id !== 'string' || !user.id.trim() || typeof session.expires !== 'string')
    throw new Error('Invalid session response');
  return candidate as Session;
}

type SessionProviderWrapperProps = {
  children: ReactNode;
  enableExpoAuthBridge?: boolean;
};

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Public NextAuth context, with owned response acceptance. NextAuth's client
 * helper converts transport failures to null, which cannot prove a logout.
 */
export default function SessionProviderWrapper({
  children,
  enableExpoAuthBridge = false,
}: SessionProviderWrapperProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [settled, setSettled] = useState(false);
  const sessionRef = useRef<Session | null>(null);
  const requestSequenceRef = useRef(0);
  const mountedRef = useRef(false);
  const broadcastIdentityRef = useRef<string | null>(null);

  useIsomorphicLayoutEffect(() => {
    // Every owned cookie fetch uses the same origin-scoped lock. It does not
    // coordinate top-level callbacks or other origins.
    installNextAuthCookieFetchLock();
  }, []);

  const update = useCallback(async (payload?: unknown): Promise<Session | null> => {
    const sequence = ++requestSequenceRef.current;
    const epoch = captureWebSessionEpoch();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15_000);
    const ownsResult = () =>
      mountedRef.current && requestSequenceRef.current === sequence && captureWebSessionEpoch() === epoch;
    try {
      let requestInit: RequestInit = { cache: 'no-store', signal: controller.signal };
      if (payload !== undefined) {
        const csrfResponse = await fetch('/api/auth/csrf', requestInit);
        const csrfBody: unknown = await csrfResponse.json();
        if (!ownsResult()) return sessionRef.current;
        if (
          !csrfResponse.ok ||
          typeof csrfBody !== 'object' ||
          csrfBody === null ||
          !('csrfToken' in csrfBody) ||
          typeof csrfBody.csrfToken !== 'string'
        ) {
          throw new Error('Session update is unavailable');
        }
        requestInit = {
          ...requestInit,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csrfToken: csrfBody.csrfToken, data: payload }),
        };
      }
      const response = await fetch('/api/auth/session', requestInit);
      const body: unknown = await response.json();
      if (!ownsResult() || controller.signal.aborted) return sessionRef.current;
      if (!response.ok) throw new Error('Session authority is unavailable');
      const acceptedSession = parseSession(body);
      sessionRef.current = acceptedSession;
      setSession(acceptedSession);
      setSettled(true);
      return acceptedSession;
    } catch {
      // Uncertainty leaves both the accepted owner and credential state intact.
      // A first load remains loading until a later successful read.
      return sessionRef.current;
    } finally {
      clearTimeout(deadline);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void update();
    const refresh = () => {
      void update();
    };
    const externalRefresh = () => {
      beginWebSessionIntent();
      refresh();
    };
    const storageRefresh = (event: StorageEvent) => {
      if (event.key === NEXT_AUTH_STORAGE_KEY) externalRefresh();
    };
    window.addEventListener(WEB_SESSION_REFRESH_EVENT, refresh);
    window.addEventListener('storage', storageRefresh);
    window.addEventListener('online', refresh);
    let channel: BroadcastChannel | undefined;
    const onExpoMessage = (event: MessageEvent<unknown>) => {
      if (isExpoAuthClearMessage(event.data)) externalRefresh();
    };
    if (enableExpoAuthBridge && typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(EXPO_AUTH_CHANNEL_NAME);
        channel.addEventListener('message', onExpoMessage);
      } catch {
        /* The local provider still works without cross-tab hints. */
      }
    }
    return () => {
      mountedRef.current = false;
      ++requestSequenceRef.current;
      window.removeEventListener(WEB_SESSION_REFRESH_EVENT, refresh);
      window.removeEventListener('storage', storageRefresh);
      window.removeEventListener('online', refresh);
      channel?.removeEventListener('message', onExpoMessage);
      channel?.close();
    };
  }, [enableExpoAuthBridge, update]);

  useEffect(() => {
    if (!enableExpoAuthBridge || !settled) return;
    const identity = session ? `${session.user.id}:${session.authSessionId ?? 'pending-login-identity'}` : 'anonymous';
    if (broadcastIdentityRef.current === identity) return;
    broadcastIdentityRef.current = identity;
    // Public NextAuth notification reaches already-open Expo/legacy pages.
    // Its nullable result is never accepted as an authority decision here.
    void getSession().catch(() => {});
  }, [enableExpoAuthBridge, session, settled]);

  const context = useMemo<SessionContextValue>(
    () =>
      session
        ? { data: session, status: 'authenticated', update }
        : { data: null, status: settled ? 'unauthenticated' : 'loading', update },
    [session, settled, update],
  );

  return <SessionContext.Provider value={context}>{children}</SessionContext.Provider>;
}
