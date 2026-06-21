// PartyProfileProvider — mirrors web's
// `packages/web/app/components/party-manager/party-profile-context.tsx`.
// It keeps the shared party-profile UUID and PostHog identity reconciliation,
// while omitting web-only concerns such as OAuth-pending drain, NextAuth session
// bridging, and locale person-property sync.
// The party profile itself is just `{ id: UUID }` — used as a stable peer
// identity for the WebSocket party session. username/avatarUrl are surfaced
// for API parity but resolve to undefined until mobile fetches the user's
// profile from the backend.
//
// Consolidation with the authenticated user-profile fetch is tracked in
// https://github.com/boardsesh/boardsesh/issues/2392 — both web and mobile
// currently mix the party-UUID identity and the authenticated user profile
// in this single provider; the issue lays out the cleaner split.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { randomUUID } from 'expo-crypto';
import { ensureProfile, type PartyProfile } from '@boardsesh/party-profile';
import { reconcileAnalyticsIdentity } from '@boardsesh/analytics';
import { partyProfileStorage } from '../lib/party-profile-store';
import { alias, identify, reset } from '../lib/analytics';
import { aliasDedupeStore } from '../lib/analytics-alias-store';
import { useProfile } from '../lib/graphql/hooks';
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
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  // The authenticated user's profile (id + email + display fields). Gated on auth
  // so signed-out launches don't fire the query. Shared `['profile']` query key,
  // so this dedupes with the profile/discover screens that also read it.
  const { data: userProfile } = useProfile({ enabled: isAuthenticated });
  const lastAnalyticsDistinctId = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;
    // Inject expo-crypto's randomUUID: Hermes has no global crypto.randomUUID,
    // so the shared default generator throws. Mirrors web, which injects uuid v4.
    ensureProfile(partyProfileStorage, randomUUID)
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

  // Wire PostHog identity the same way web does (party-profile-context.tsx): the
  // party-profile UUID is the anonymous distinct_id; once the authenticated user
  // id resolves we alias it to the user and switch identity, so a person's
  // pre-login mobile events — and their web events, same PostHog project — merge.
  // The reset/identify/alias state machine is the shared, pure
  // reconcileAnalyticsIdentity from @boardsesh/analytics.
  const profileId = profile?.id;
  const authUserId = userProfile?.id ?? null;
  const authEmail = userProfile?.email ?? null;

  useEffect(() => {
    // Skip while the party UUID is still loading, and while auth is still
    // resolving (mirrors web's `sessionStatus === 'loading'` guard) so we never
    // reconcile against a half-known state. When the session is authenticated
    // but the user id hasn't been fetched yet, we pass the *raw* isAuthenticated
    // so reconcileAnalyticsIdentity holds (no identify) rather than momentarily
    // re-identifying a returning user as the anonymous UUID; the alias →
    // identify(user) switch then fires once authUserId lands.
    if (!profileId || isAuthLoading) return;
    lastAnalyticsDistinctId.current = reconcileAnalyticsIdentity({
      profileId,
      authUserId,
      authEmail,
      isAuthenticated,
      lastDistinctId: lastAnalyticsDistinctId.current,
      client: { identify, alias, reset },
      aliasStore: aliasDedupeStore,
    });
  }, [profileId, isAuthLoading, isAuthenticated, authUserId, authEmail]);

  const refreshProfile = useCallback(async () => {
    try {
      const loaded = await ensureProfile(partyProfileStorage, randomUUID);
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
      // Display fields come from the authenticated user's profile (GET_PROFILE),
      // fetched above. Undefined until it loads or while signed out.
      username: userProfile?.displayName,
      avatarUrl: userProfile?.avatarUrl,
      isAuthenticated,
      refreshProfile,
    }),
    [profile, isLoading, isAuthenticated, refreshProfile, userProfile?.displayName, userProfile?.avatarUrl],
  );

  return <PartyProfileContext.Provider value={value}>{children}</PartyProfileContext.Provider>;
}

export function usePartyProfile(): PartyProfileContextValue {
  const ctx = useContext(PartyProfileContext);
  if (!ctx) throw new Error('usePartyProfile must be used within a PartyProfileProvider');
  return ctx;
}
