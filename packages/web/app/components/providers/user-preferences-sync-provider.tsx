'use client';

import { useEffect, useRef } from 'react';

import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { pullInitial, setupAutoFlush } from '@/app/lib/user-preferences-sync';

/**
 * Mounts the user-preferences sync engine. Pulls the server state once
 * per authenticated token, then keeps the local sync queue drained on
 * `online` events. Renders nothing.
 *
 * Mount this somewhere inside the SessionProvider — it depends on the
 * NextAuth-derived auth token.
 */
export function UserPreferencesSyncProvider(): null {
  const { token, isAuthenticated } = useWsAuthToken();
  const lastPulledTokenRef = useRef<string | null>(null);
  const latestTokenRef = useRef<string | null>(null);
  latestTokenRef.current = token;

  useEffect(() => {
    if (!isAuthenticated || !token) {
      // When the user signs out, allow a fresh pull next time they sign in.
      lastPulledTokenRef.current = null;
      return;
    }
    if (lastPulledTokenRef.current === token) return;
    lastPulledTokenRef.current = token;
    void pullInitial(token);
  }, [token, isAuthenticated]);

  useEffect(() => {
    const cleanup = setupAutoFlush(() => latestTokenRef.current);
    return cleanup;
  }, []);

  return null;
}
