'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { browserBackendClient } from '@/app/lib/auth/browser-backend-client';
import {
  browserBackendSessionKey,
  readBrowserBackendSessionScope,
} from '@boardsesh/auth-protocol/browser-backend-session';
import { requestWebSessionRefreshForView } from '@/app/lib/auth/web-session-events';

const serverSnapshot = () => null;

/** undefined retains legacy behavior; null hides an unconfirmed selected view.
 * A string labels one actual accepted browser revision, never a credential. */
export function useCncBrowserScope(session: unknown): string | null | undefined {
  const snapshot = useSyncExternalStore(
    browserBackendClient.subscribe,
    browserBackendClient.getSnapshot,
    serverSnapshot,
  );
  const observed = readBrowserBackendSessionScope(session);
  const accepted = snapshot !== null && browserBackendClient.isSessionCurrent(session);
  useEffect(() => {
    if (
      !snapshot?.selected ||
      snapshot.closed ||
      accepted ||
      session === null ||
      typeof session !== 'object' ||
      (snapshot.owner !== null &&
        (observed.status !== 'selected' ||
          browserBackendSessionKey(snapshot.owner) !== browserBackendSessionKey(observed.owner)))
    )
      return;
    requestWebSessionRefreshForView(session, snapshot.revision);
  }, [accepted, observed, session, snapshot]);
  if (!snapshot) return browserBackendClient.isSelected() ? null : undefined;
  if (snapshot.closed) return null;
  if (!snapshot.selected) return undefined;
  if (!accepted) return null;
  if (observed.status === 'selected')
    return JSON.stringify([browserBackendSessionKey(observed.owner), snapshot.revision]);
  if (observed.status === 'anonymous') return JSON.stringify(['selected-anonymous', snapshot.revision]);
  return null;
}
