// ConnectionSettingsProvider — mirrors
// `packages/web/app/components/connection-manager/connection-settings-context.tsx`.
//
// Web's version manages a direct/backend party-mode toggle plus a configurable
// backend WS URL. Mobile only has the backend mode today (no peer-to-peer WS,
// no env-overridable backend URL beyond `EXPO_PUBLIC_BACKEND_URL`), so the
// setter is a no-op unless we choose to wire it to a feature flag later. The
// API surface mirrors web so future shared consumers don't have to fork.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BACKEND_URL } from '../lib/env';
import { getStoredPartyMode, setStoredPartyMode, type StoredPartyMode } from '../lib/connection-settings-store';

export type PartyMode = StoredPartyMode;

type ConnectionSettingsContextValue = {
  backendUrl: string | null;
  partyMode: PartyMode;
  setPartyMode: (mode: PartyMode) => void;
  isLoaded: boolean;
};

const ConnectionSettingsContext = createContext<ConnectionSettingsContextValue | undefined>(undefined);

export function ConnectionSettingsProvider({ children }: { children: ReactNode }) {
  const [storedPartyMode, setStoredPartyModeState] = useState<PartyMode>('backend');
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    getStoredPartyMode()
      .then((stored) => {
        if (stored !== null) {
          setStoredPartyModeState(stored);
        }
      })
      .finally(() => {
        setIsLoaded(true);
      });
  }, []);

  const setPartyMode = useCallback((mode: PartyMode) => {
    setStoredPartyModeState(mode);
    setStoredPartyMode(mode).catch(() => {
      // Best-effort persistence; in-memory state is the source of truth for
      // the rest of the session.
    });
  }, []);

  const value = useMemo<ConnectionSettingsContextValue>(
    () => ({
      backendUrl: BACKEND_URL,
      partyMode: storedPartyMode,
      setPartyMode,
      isLoaded,
    }),
    [storedPartyMode, setPartyMode, isLoaded],
  );

  return <ConnectionSettingsContext.Provider value={value}>{children}</ConnectionSettingsContext.Provider>;
}

export function useConnectionSettings(): ConnectionSettingsContextValue {
  const ctx = useContext(ConnectionSettingsContext);
  if (!ctx) throw new Error('useConnectionSettings must be used within a ConnectionSettingsProvider');
  return ctx;
}

export function useBackendUrl() {
  const { backendUrl, isLoaded } = useConnectionSettings();
  return { backendUrl, isLoaded };
}

export function usePartyMode() {
  const { partyMode, setPartyMode, isLoaded } = useConnectionSettings();
  return { partyMode, setPartyMode, isLoaded };
}
