'use client';

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  browserBackendSessionKey,
  readBrowserBackendSessionScope,
} from '@boardsesh/auth-protocol/browser-backend-session';
import type { BrowserBackendLeaseOwner } from '@boardsesh/auth-protocol/browser-backend-lease';
import { browserBackendClient } from '@/app/lib/auth/browser-backend-client';
import { requestWebSessionRefresh } from '@/app/lib/auth/web-session-events';

// One recovery per actual accepted response, shared by every island. Neither
// this bookkeeping nor React/Flight props contain credentials or receipts.
const refreshedRoutes = new WeakSet<object>();
const refreshedSessions = new WeakMap<object, number>();
const serverSnapshot = () => null;

/** Children must contain no viewer-private server props: even hidden children
 * are serialized into Flight. Mount private client fetches only after matching
 * an actual accepted session receipt, including its local retirement revision. */
export default function SelectedPrivateView({
  expectedOwner,
  children,
  fallback = null,
}: {
  expectedOwner: BrowserBackendLeaseOwner;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const snapshot = useSyncExternalStore(
    browserBackendClient.subscribe,
    browserBackendClient.getSnapshot,
    serverSnapshot,
  );
  const current = readBrowserBackendSessionScope(session);
  const accepted = snapshot !== null && browserBackendClient.isSessionCurrent(session);
  const matches =
    accepted &&
    current.status === 'selected' &&
    browserBackendSessionKey(current.owner) === browserBackendSessionKey(expectedOwner);

  useEffect(() => {
    if (!snapshot || !session || status !== 'authenticated' || matches) return;
    if (accepted) {
      if (refreshedRoutes.has(session)) return;
      refreshedRoutes.add(session);
      // A stale prefetch may supply an old metadata label. Refresh once using
      // current cookies; never reveal the mismatched island while waiting.
      router.refresh();
    } else if (
      snapshot.selected &&
      (snapshot.owner === null ||
        (current.status === 'selected' &&
          browserBackendSessionKey(snapshot.owner) === browserBackendSessionKey(current.owner))) &&
      refreshedSessions.get(session) !== snapshot.revision
    ) {
      // A different owner can already be admitted while SessionProvider awaits
      // ordered cleanup. Do not supersede that pending response with a GET.
      refreshedSessions.set(session, snapshot.revision);
      requestWebSessionRefresh();
    }
  }, [accepted, current, matches, router, session, snapshot, status]);

  return matches ? children : fallback;
}
