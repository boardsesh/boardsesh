// ConnectionSettingsProvider — mirrors
// `packages/web/app/components/connection-manager/connection-settings-context.tsx`.
//
// All party-mode traffic flows through the backend WS today; there's no
// peer-to-peer "direct" mode, so the provider's only responsibility is
// exposing the resolved `backendUrl` (from `EXPO_PUBLIC_BACKEND_URL`, with
// a `https://ws.boardsesh.com` fallback). No persisted state — the URL is
// constant for the app's lifetime.

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { BACKEND_URL } from '../lib/env';

type ConnectionSettingsContextValue = {
  backendUrl: string | null;
};

const ConnectionSettingsContext = createContext<ConnectionSettingsContextValue | undefined>(undefined);

export function ConnectionSettingsProvider({ children }: { children: ReactNode }) {
  const value = useMemo<ConnectionSettingsContextValue>(() => ({ backendUrl: BACKEND_URL }), []);
  return <ConnectionSettingsContext.Provider value={value}>{children}</ConnectionSettingsContext.Provider>;
}

export function useConnectionSettings(): ConnectionSettingsContextValue {
  const ctx = useContext(ConnectionSettingsContext);
  if (!ctx) throw new Error('useConnectionSettings must be used within a ConnectionSettingsProvider');
  return ctx;
}

export function useBackendUrl() {
  const { backendUrl } = useConnectionSettings();
  return { backendUrl };
}
