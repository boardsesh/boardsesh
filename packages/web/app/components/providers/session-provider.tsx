'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { Session } from 'next-auth';
import { getSession, SessionContext, type SessionContextValue } from 'next-auth/react';
import { installNextAuthCookieFetchLock } from '../../lib/auth/nextauth-cookie-fetch-lock';
import { BROWSER_COORDINATOR_FRAME_PATH } from '@boardsesh/auth-protocol/browser-coordinator';
import { publicBrowserCoordinatorReady } from '../../lib/auth/browser-coordinator-readiness';
import { readCanonicalBrowserCoordinator } from '../../lib/auth/browser-coordinator-client';
import { browserBackendClient } from '../../lib/auth/browser-backend-client';
import { PRIVACY_REVOKED_EVENT } from '../../lib/privacy-client';
import { CNC_CONFIGURATOR_DRAFT_KEY } from '@/app/build-plans/configurator/configurator-state';
import { removePreference } from '../../lib/user-preferences-db';
import {
  beginWebSessionIntent,
  captureWebSessionEpoch,
  requestWebSessionRefresh,
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

async function readSessionJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) return response.json();
  const reader = response.body.getReader();
  const cancelBody = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancelBody, { once: true });
  try {
    if (signal.aborted) {
      cancelBody();
      throw new Error('Session authority is unavailable');
    }
    const decoder = new TextDecoder();
    let contents = '';
    while (true) {
      const chunk = await reader.read();
      if (signal.aborted) throw new Error('Session authority is unavailable');
      if (chunk.done) break;
      contents += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(contents + decoder.decode());
  } finally {
    signal.removeEventListener('abort', cancelBody);
    reader.releaseLock();
  }
}

type SessionProviderWrapperProps = {
  children: ReactNode;
  enableExpoAuthBridge?: boolean;
  canonicalBrowserOrigin?: string;
};

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Public NextAuth context, with owned response acceptance. NextAuth's client
 * helper converts transport failures to null, which cannot prove a logout.
 */
export default function SessionProviderWrapper({
  children,
  enableExpoAuthBridge = false,
  canonicalBrowserOrigin,
}: SessionProviderWrapperProps) {
  const [acceptedView, setAcceptedView] = useState<{
    session: Session | null;
    clientScopeKey: string | null;
    retired: boolean;
  }>({
    session: null,
    clientScopeKey: null,
    retired: false,
  });
  const { session, clientScopeKey, retired } = acceptedView;
  const [settled, setSettled] = useState(false);
  const clientScopeKeyRef = useRef<string | null>(null);
  const selectedCleanupRef = useRef<Promise<void> | null>(null);
  const settledRef = useRef(false);
  const sessionRef = useRef<Session | null>(null);
  const requestSequenceRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1000);
  const mountedRef = useRef(false);
  const suspendedRef = useRef(false);
  const broadcastIdentityRef = useRef<string | null>(null);

  useIsomorphicLayoutEffect(() => {
    // Every owned cookie fetch uses the same origin-scoped lock. It does not
    // coordinate top-level callbacks or other origins.
    installNextAuthCookieFetchLock();
  }, []);

  const update = useCallback(
    async (payload?: unknown): Promise<Session | null> => {
      if (suspendedRef.current) return null;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      const sequence = ++requestSequenceRef.current;
      activeControllerRef.current?.abort();
      const epoch = captureWebSessionEpoch();
      const controller = new AbortController();
      activeControllerRef.current = controller;
      const ownsResult = () =>
        mountedRef.current &&
        !suspendedRef.current &&
        requestSequenceRef.current === sequence &&
        captureWebSessionEpoch() === epoch;
      const scheduleInitialRetry = () => {
        if (!ownsResult() || settledRef.current || retryTimerRef.current !== null) return;
        const retryDelay = retryDelayRef.current;
        retryDelayRef.current = Math.min(retryDelay * 2, 30_000);
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          if (ownsResult() && !settledRef.current) requestWebSessionRefresh(epoch);
        }, retryDelay);
      };
      const deadline = setTimeout(() => {
        controller.abort();
        // A body reader can outlive abort. Initial recovery must not depend on
        // that old promise settling; its eventual result still has to be owned.
        scheduleInitialRetry();
      }, 15_000);
      try {
        if (publicBrowserCoordinatorReady()) {
          if (!canonicalBrowserOrigin) throw new Error('Session authority is unavailable');
          await readCanonicalBrowserCoordinator(canonicalBrowserOrigin, controller.signal);
          if (!ownsResult() || controller.signal.aborted) return sessionRef.current;
        }
        let requestInit: RequestInit = { cache: 'no-store', signal: controller.signal };
        if (payload !== undefined) {
          const csrfResponse = await fetch('/api/auth/csrf', requestInit);
          const csrfBody = await readSessionJson(csrfResponse, controller.signal);
          if (!ownsResult()) return sessionRef.current;
          if (controller.signal.aborted) throw new Error('Session update is unavailable');
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
        const body = await readSessionJson(response, controller.signal);
        if (!ownsResult()) return sessionRef.current;
        if (controller.signal.aborted) throw new Error('Session authority is unavailable');
        if (!response.ok) throw new Error('Session authority is unavailable');
        const acceptedSession = parseSession(body);
        // The authority/controller lives above this key. Retire old request
        // receipts before exposing the new context, including same-UID logins.
        const acceptedScopeKey = browserBackendClient.acceptSession(acceptedSession);
        if (acceptedScopeKey !== clientScopeKeyRef.current) {
          const previousUserId = sessionRef.current?.user.id;
          if (previousUserId && previousUserId !== acceptedSession?.user.id) {
            // A selected remount skips the legacy cache buster's initial effect.
            // Preserve main's UID-switch/sign-out cleanup; anonymous sign-in and
            // another login for the same account retain their existing policy.
            const cleanup = (selectedCleanupRef.current ?? Promise.resolve()).then(async () => {
              try {
                await removePreference(CNC_CONFIGURATOR_DRAFT_KEY);
              } catch {
                /* Preserve the existing best-effort preference cleanup policy. */
              }
            });
            selectedCleanupRef.current = cleanup;
            void cleanup.then(() => {
              if (selectedCleanupRef.current === cleanup) selectedCleanupRef.current = null;
            });
          }
        }
        // A newer response joins older cleanup even when it returns to the same
        // UID. No older deletion may finish after the new view creates a draft.
        const pendingCleanup = selectedCleanupRef.current;
        if (pendingCleanup) {
          await pendingCleanup;
          if (!ownsResult()) return sessionRef.current;
          if (controller.signal.aborted) {
            // Cleanup may outlive the request deadline. Re-read through GET once
            // it settles; never publish the old response or replay an update POST.
            requestWebSessionRefresh(epoch);
            return sessionRef.current;
          }
        }
        if (acceptedScopeKey !== clientScopeKeyRef.current) {
          clientScopeKeyRef.current = acceptedScopeKey;
          if (typeof window !== 'undefined') window.dispatchEvent(new Event(PRIVACY_REVOKED_EVENT));
        }
        sessionRef.current = acceptedSession;
        settledRef.current = true;
        retryDelayRef.current = 1000;
        if (retryTimerRef.current !== null) {
          clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        // Identity and subtree ownership are one update, independent of React's
        // batching or a synchronous external-store notification during admission.
        setAcceptedView({ session: acceptedSession, clientScopeKey: acceptedScopeKey, retired: false });
        setSettled(true);
        return acceptedSession;
      } catch {
        // Uncertainty leaves both the accepted owner and credential state intact.
        // Only an unknown initial owner retries, and the timer always reads GET
        // through the public refresh event instead of replaying an update POST.
        scheduleInitialRetry();
        return sessionRef.current;
      } finally {
        clearTimeout(deadline);
        if (activeControllerRef.current === controller) activeControllerRef.current = null;
      }
    },
    [canonicalBrowserOrigin],
  );

  useEffect(() => {
    // The canonical utility frame owns coordination only. Its layout must not
    // recursively create another frame or roll a separate NextAuth cookie.
    if (publicBrowserCoordinatorReady() && window.location.pathname === BROWSER_COORDINATOR_FRAME_PATH) return;
    mountedRef.current = true;
    suspendedRef.current = false;
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
    const pageHide = () => {
      // A frozen document cannot keep an accepted private receipt. Retire
      // before suspension, and reject even transports that ignore abort.
      suspendedRef.current = true;
      ++requestSequenceRef.current;
      activeControllerRef.current?.abort();
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (browserBackendClient.isSelected()) {
        // The browser can freeze the document as soon as this event returns.
        // Retiring a receipt alone leaves React's pending DOM update batched.
        flushSync(() => {
          browserBackendClient.retire();
          // A committed child can still be waiting for its passive store
          // subscription. Publish retirement through the provider too, without
          // discarding the accepted identity or claiming an anonymous read.
          setAcceptedView((current) => (current.retired ? current : { ...current, retired: true }));
        });
      }
    };
    const pageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      suspendedRef.current = false;
      externalRefresh();
    };
    window.addEventListener(WEB_SESSION_REFRESH_EVENT, refresh);
    window.addEventListener('storage', storageRefresh);
    window.addEventListener('online', refresh);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', pageShow);
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
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      window.removeEventListener(WEB_SESSION_REFRESH_EVENT, refresh);
      window.removeEventListener('storage', storageRefresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
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
      retired
        ? { data: null, status: 'loading', update }
        : session
          ? { data: session, status: 'authenticated', update }
          : { data: null, status: settled ? 'unauthenticated' : 'loading', update },
    [retired, session, settled, update],
  );

  return (
    <SessionContext.Provider value={context}>
      <React.Fragment key={clientScopeKey ?? 'legacy'}>{children}</React.Fragment>
    </SessionContext.Provider>
  );
}
