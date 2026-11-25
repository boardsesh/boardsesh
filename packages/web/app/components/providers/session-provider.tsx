'use client';

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from 'next-auth';
import { getSession, SessionContext, type SessionContextValue } from 'next-auth/react';
import { installNextAuthCookieFetchLock } from '../../lib/auth/nextauth-cookie-fetch-lock';
import {
  beginWebSessionIntent,
  captureWebSessionEpoch,
  requestWebSessionRefresh,
  WEB_SESSION_REFRESH_EVENT,
} from '../../lib/auth/web-session-events';
import {
  browserSessionGuard,
  sessionViewerKey,
  readProbedViewer,
  sessionViewerOf,
  WEB_SESSION_CHECK_EVENT,
} from '../../lib/auth/session-guard';

export { useSession as useBrowserSession } from 'next-auth/react';
export type { Session as BrowserSession } from 'next-auth';
export { SessionContext as BrowserSessionContext } from 'next-auth/react';
export type { SessionContextValue as BrowserSessionContextValue } from 'next-auth/react';

/** Reads an existing browser session without requiring a provider or starting a session request. */
export function useOptionalBrowserSession(): SessionContextValue | undefined {
  return useContext(SessionContext);
}

const EXPO_AUTH_CHANNEL_NAME = 'boardsesh-expo-web-auth-v1';
const NEXT_AUTH_STORAGE_KEY = 'nextauth.message';
// ws-auth reads the cookie without rewriting it, unlike NextAuth's session GET.
// Under `better-auth` it answers the same ids as the session read (#7596 B3b).
const IDENTITY_PROBE_PATH = '/api/internal/ws-auth';
const FOCUS_CHECK_INTERVAL_MS = 30_000;

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
  awaitExpoAuthBridge?: boolean;
};

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Public NextAuth context, with owned response acceptance. NextAuth's client
 * helper converts transport failures to null, which cannot prove a logout.
 */
export default function SessionProviderWrapper({
  children,
  enableExpoAuthBridge = false,
  awaitExpoAuthBridge = false,
}: SessionProviderWrapperProps) {
  const [acceptedView, setAcceptedView] = useState<{ session: Session | null; retired: boolean }>({
    session: null,
    retired: false,
  });
  const { session, retired } = acceptedView;
  const [settled, setSettled] = useState(false);
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

  const update = useCallback(async (payload?: unknown): Promise<Session | null> => {
    if (suspendedRef.current) return null;
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    const sequence = ++requestSequenceRef.current;
    // A re-check asked for after this read started is not answered by it.
    const readStarted = browserSessionGuard().sessionReadStarted();
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
      // An account change made in another tab or app is never shown in this
      // page: the guard clears its caches and reloads it from the root.
      if (browserSessionGuard().accept(sessionViewerOf(acceptedSession), readStarted) === 'retire') {
        setAcceptedView((current) => (current.retired ? current : { ...current, retired: true }));
        return sessionRef.current;
      }
      sessionRef.current = acceptedSession;
      settledRef.current = true;
      retryDelayRef.current = 1000;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      setAcceptedView({ session: acceptedSession, retired: false });
      setSettled(true);
      return acceptedSession;
    } catch {
      // Uncertainty leaves both the accepted owner and credential state intact.
      // Only an unknown initial owner retries, and the timer always reads GET
      // through the public refresh event instead of replaying an update POST.
      scheduleInitialRetry();
      // A re-check waiting on this read learns that it proved nothing.
      if (ownsResult()) browserSessionGuard().sessionChecked(readStarted);
      return sessionRef.current;
    } finally {
      clearTimeout(deadline);
      if (activeControllerRef.current === controller) activeControllerRef.current = null;
    }
  }, []);

  useEffect(() => {
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
      // A frozen document keeps its accepted session but drops any read in
      // flight, and rejects even transports that ignore abort.
      suspendedRef.current = true;
      ++requestSequenceRef.current;
      activeControllerRef.current?.abort();
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
    const pageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      suspendedRef.current = false;
      externalRefresh();
    };
    // Focus and a 401 compare the cookie's account with the published one, and
    // read the session (which rewrites the cookie) only when they differ. The
    // first focus after the page settles always checks.
    let lastIdentityCheck = 0;
    let identityProbe: AbortController | null = null;
    // A 401 or 409 that lands while a probe is out may have met a cookie that
    // changed after that probe read it, so one more probe runs when it ends.
    let recheckAfterProbe = false;
    // The viewer a probe last found ended (401), so the next 401 for it reads nothing.
    let endedProbeViewer: string | undefined;
    const checkIdentity = async (throttled: boolean) => {
      if (suspendedRef.current || !settledRef.current) return;
      if (identityProbe) {
        if (!throttled) recheckAfterProbe = true;
        return;
      }
      if (throttled && Date.now() - lastIdentityCheck < FOCUS_CHECK_INTERVAL_MS) return;
      lastIdentityCheck = Date.now();
      const probe = new AbortController();
      const probeStarted = browserSessionGuard().sessionReadStarted();
      identityProbe = probe;
      const deadline = setTimeout(() => probe.abort(), 15_000);
      let readsSession = false;
      // The probe read the page's own login again: a held reply under a false viewer marker may land.
      let confirmed = false;
      try {
        const response = await fetch(IDENTITY_PROBE_PATH, { cache: 'no-store', signal: probe.signal });
        // An outage proves nothing and keeps the accepted session. A 401 (only
        // under `better-auth`, #7596 B3b) says the cookie's session ended: the
        // session read that follows decides what the page shows.
        // Once per accepted viewer: if the session read that follows keeps the
        // same login, a repeated 401 proves nothing (#7792 review, L2).
        const viewerBefore = browserSessionGuard().viewerKey();
        const sessionEnded = response.status === 401 && endedProbeViewer !== viewerBefore;
        if (response.status === 401) endedProbeViewer = viewerBefore;
        else if (response.ok) endedProbeViewer = undefined;
        const probed = response.ok ? readProbedViewer(await response.json()) : undefined;
        if (sessionEnded && identityProbe === probe) {
          recheckAfterProbe = false;
          readsSession = true;
          externalRefresh();
        } else if (
          probed !== undefined &&
          identityProbe === probe &&
          sessionViewerKey(probed) !== browserSessionGuard().viewerKey()
        ) {
          // The session read that follows answers the queued check too.
          recheckAfterProbe = false;
          readsSession = true;
          externalRefresh();
        } else if (probed !== undefined && sessionViewerKey(probed) === browserSessionGuard().viewerKey()) {
          confirmed = true;
        }
      } catch {
        /* Transport failure keeps the accepted session. */
      } finally {
        clearTimeout(deadline);
        if (identityProbe === probe) {
          identityProbe = null;
          if (recheckAfterProbe) {
            recheckAfterProbe = false;
            void checkIdentity(false);
          } else if (!readsSession) {
            // No session read follows, so a request waiting on this check goes on now.
            browserSessionGuard().sessionChecked(probeStarted, confirmed);
          }
        }
      }
    };
    const focusCheck = () => {
      if (document.visibilityState !== 'hidden') void checkIdentity(true);
    };
    const unauthorizedCheck = () => void checkIdentity(false);
    window.addEventListener(WEB_SESSION_REFRESH_EVENT, refresh);
    window.addEventListener('storage', storageRefresh);
    window.addEventListener('online', refresh);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', pageShow);
    window.addEventListener('focus', focusCheck);
    document.addEventListener('visibilitychange', focusCheck);
    window.addEventListener(WEB_SESSION_CHECK_EVENT, unauthorizedCheck);
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
      window.removeEventListener('focus', focusCheck);
      document.removeEventListener('visibilitychange', focusCheck);
      window.removeEventListener(WEB_SESSION_CHECK_EVENT, unauthorizedCheck);
      identityProbe?.abort();
      identityProbe = null;
    };
  }, [update]);

  // Static marketing HTML discovers this runtime flag after hydration. Updating
  // cross-tab hints must not cancel or restart the owned session read above.
  const listenForExpoAuth = enableExpoAuthBridge || awaitExpoAuthBridge;
  useEffect(() => {
    if (!listenForExpoAuth) return;
    if (typeof BroadcastChannel === 'undefined') return;
    let channel: BroadcastChannel;
    const externalRefresh = () => {
      beginWebSessionIntent();
      void update();
    };
    const onExpoMessage = (event: MessageEvent<unknown>) => {
      if (!isExpoAuthClearMessage(event.data)) return;
      // Unknown configuration may outlive a cross-app sign-out. The hint asks
      // for actual cookie evidence; it never supplies an accepted identity.
      externalRefresh();
    };
    try {
      channel = new BroadcastChannel(EXPO_AUTH_CHANNEL_NAME);
      channel.addEventListener('message', onExpoMessage);
    } catch {
      /* The local provider still works without cross-tab hints. */
      return;
    }
    return () => {
      channel.removeEventListener('message', onExpoMessage);
      channel.close();
    };
  }, [listenForExpoAuth, update]);

  useEffect(() => {
    if (!enableExpoAuthBridge || !settled) return;
    const identity = sessionViewerKey(sessionViewerOf(session));
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

  return <SessionContext.Provider value={context}>{children}</SessionContext.Provider>;
}
