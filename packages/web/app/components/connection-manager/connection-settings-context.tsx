'use client';

import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { removePreference } from '@/app/lib/user-preferences-db';
import { getBackendWsUrl } from '@/app/lib/backend-url';

// Backend URL resolved at runtime (supports PR preview domains)
const BACKEND_URL = getBackendWsUrl();

type ConnectionSettingsContextType = {
  // Backend URL (from env var only)
  backendUrl: string | null;
};

const ConnectionSettingsContext = createContext<ConnectionSettingsContextType | undefined>(undefined);

export const ConnectionSettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Best-effort cleanup of legacy preference keys. `partyMode` used to toggle
  // between a direct peer-to-peer transport and the backend WS; the direct
  // path was removed (all party sessions now flow through ws.boardsesh.com),
  // so the stored value is orphan. `backendUrl` was a stored override from an
  // older iteration. Cleaning here keeps existing devices from carrying dead
  // IDB entries forever.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    removePreference('boardsesh:partyMode').catch(() => {});
    removePreference('boardsesh:backendUrl').catch(() => {});
  }, []);

  const value = useMemo<ConnectionSettingsContextType>(() => ({ backendUrl: BACKEND_URL }), []);

  return <ConnectionSettingsContext.Provider value={value}>{children}</ConnectionSettingsContext.Provider>;
};

export function useConnectionSettings() {
  const context = useContext(ConnectionSettingsContext);
  if (!context) {
    throw new Error('useConnectionSettings must be used within a ConnectionSettingsProvider');
  }
  return context;
}

export function useBackendUrl() {
  const { backendUrl } = useConnectionSettings();
  return { backendUrl };
}
