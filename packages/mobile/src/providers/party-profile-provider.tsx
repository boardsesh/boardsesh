// PartyProfileProvider — mirrors web's
// `packages/web/app/components/party-manager/party-profile-context.tsx` but
// strips out the web-specific glue (PostHog identity sync, OAuth-pending
// drain, NextAuth session bridging, language sync). Phase 1 = load-only.
// The party profile itself is just `{ id: UUID }` — used as a stable peer
// identity for the WebSocket party session. username/avatarUrl are surfaced
// for API parity but resolve to undefined until mobile fetches the user's
// profile from the backend.
//
// Consolidation with the authenticated user-profile fetch is tracked in
// https://github.com/boardsesh/boardsesh/issues/2392 — both web and mobile
// currently mix the party-UUID identity and the authenticated user profile
// in this single provider; the issue lays out the cleaner split.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ensureProfile, type PartyProfile } from '@boardsesh/party-profile';
import { partyProfileStorage } from '../lib/party-profile-store';
import { useAuth } from './auth-provider';

type PartyProfileContextValue = {
  profile: PartyProfile | null;
  isLoading: boolean;
  hasProfile: boolean;
  username: string | undefined;
  avatarUrl: string | undefined;
  isAuthenticated: boolean;
  refreshProfile: () => Promise<void>;
};

const PartyProfileContext = createContext<PartyProfileContextValue | undefined>(undefined);

export function PartyProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<PartyProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    let mounted = true;
    ensureProfile(partyProfileStorage)
      .then((loaded) => {
        if (mounted) setProfile(loaded);
      })
      .catch((err) => {
        if (__DEV__) console.warn('[party-profile] load failed', err);
      })
      .finally(() => {
        if (mounted) setIsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const loaded = await ensureProfile(partyProfileStorage);
      setProfile(loaded);
    } catch (err) {
      if (__DEV__) console.warn('[party-profile] refresh failed', err);
    }
  }, []);

  const value = useMemo<PartyProfileContextValue>(
    () => ({
      profile,
      isLoading,
      hasProfile: profile !== null,
      // Mobile doesn't fetch the authenticated user's display profile yet —
      // see `packages/mobile/src/lib/graphql/operations.ts` for the existing
      // displayName/avatarUrl queries; wiring them in here is the natural
      // follow-up once a consumer screen needs them.
      username: undefined,
      avatarUrl: undefined,
      isAuthenticated,
      refreshProfile,
    }),
    [profile, isLoading, isAuthenticated, refreshProfile],
  );

  return <PartyProfileContext.Provider value={value}>{children}</PartyProfileContext.Provider>;
}

export function usePartyProfile(): PartyProfileContextValue {
  const ctx = useContext(PartyProfileContext);
  if (!ctx) throw new Error('usePartyProfile must be used within a PartyProfileProvider');
  return ctx;
}
