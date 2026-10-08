import { useAnalyticsConsent } from '../lib/consent-hooks';
// PartyProfileProvider — mirrors web's
// `packages/web/app/components/party-manager/party-profile-context.tsx`.
// It keeps the shared party-profile UUID and PostHog identity reconciliation,
// while omitting web-only concerns such as OAuth-pending drain, NextAuth session
// bridging, and locale person-property sync.
// The party profile itself is just `{ id: UUID }` — used as a stable peer
// identity for the WebSocket party session. It is NOT a PostHog id: analytics
// identity is the SDK's own anonymous id until sign-in, then the user id. username/avatarUrl are surfaced
// for API parity but resolve to undefined until mobile fetches the user's
// profile from the backend.
//
// Consolidation with the authenticated user-profile fetch is tracked in
// https://github.com/boardsesh/boardsesh/issues/2392 — both web and mobile
// currently mix the party-UUID identity and the authenticated user profile
// in this single provider; the issue lays out the cleaner split.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { randomUUID } from 'expo-crypto';
import { ensureProfile, type PartyProfile } from '@boardsesh/party-profile';
import { reconcileAnalyticsIdentity, buildCohortPersonProperties } from '@boardsesh/analytics';
import { toBoardName } from '@boardsesh/board-config';
import { partyProfileStorage } from '../lib/party-profile-store';
import { getAnalyticsIdentity, identify, onAnalyticsReady, reset, setPersonProperties } from '../lib/analytics';
import { useProfile } from '../lib/graphql/hooks';
import { useHomeBoard } from '../lib/graphql/hooks/use-home-board';
import { useIntegrationStatuses } from '../lib/graphql/hooks/use-integrations';
import { useAuth } from './auth-provider';

type PartyProfileContextValue = {
  profile: PartyProfile | null;
  isLoading: boolean;
  hasProfile: boolean;
  username: string | undefined;
  avatarUrl: string | undefined;
  /** Authenticated account id, separate from the device-scoped party profile. */
  authenticatedUserId: string | null;
  isAuthenticated: boolean;
  refreshProfile: () => Promise<void>;
};

const PartyProfileContext = createContext<PartyProfileContextValue | undefined>(undefined);

export function PartyProfileProvider({ children }: { children: ReactNode }) {
  const analyticsGranted = useAnalyticsConsent();
  const [profile, setProfile] = useState<PartyProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  // The authenticated user's profile (id + email + display fields). Gated on auth
  // so signed-out launches don't fire the query. Shared `['profile']` query key,
  // so this dedupes with the profile/discover screens that also read it.
  const { data: userProfile } = useProfile({ enabled: isAuthenticated });
  const { board: homeBoard } = useHomeBoard();
  const { data: integrationStatuses } = useIntegrationStatuses();

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

  // Wire PostHog identity. Signed out, the SDK stays on its own anonymous id and
  // nothing is sent. Once the authenticated user id resolves we identify as the
  // user, and that identify carries the SDK's anonymous id so PostHog merges the
  // pre-login events into the account's person (the same person web identifies,
  // same PostHog project). The state machine is the shared, pure
  // reconcileAnalyticsIdentity from @boardsesh/analytics; its header has the
  // rules and why the party-profile UUID is no longer part of this.
  const authUserId = userProfile?.id ?? null;
  const authEmail = userProfile?.email ?? null;

  // Stateless and safe to repeat: it reads the SDK's ids on every run and does
  // nothing when they already match the auth state.
  const reconcileIdentity = useCallback(() => {
    reconcileAnalyticsIdentity({
      authUserId,
      authEmail,
      isAuthenticated,
      client: {
        identify,
        reset,
        getDistinctId: () => getAnalyticsIdentity()?.distinctId ?? null,
        getAnonymousId: () => getAnalyticsIdentity()?.anonymousId ?? null,
      },
    });
  }, [authUserId, authEmail, isAuthenticated]);

  useEffect(() => {
    // Skip while auth is still resolving (mirrors web's
    // `sessionStatus === 'loading'` guard) so we never reconcile against a
    // half-known state. When the session is authenticated but the user id
    // hasn't been fetched yet, we pass the *raw* isAuthenticated so
    // reconcileAnalyticsIdentity holds; the identify(user) switch then fires
    // once authUserId lands.
    if (isAuthLoading || !analyticsGranted) return;
    // The routine reads who the SDK thinks it is, and the SDK only knows after
    // it has loaded its storage. A signed-out auth check can finish first, so
    // wait rather than reconcile against empty ids. Once the SDK is loaded the
    // callback runs before this returns.
    return onAnalyticsReady(reconcileIdentity);
  }, [isAuthLoading, reconcileIdentity, analyticsGranted]);

  const hasUserProfile = !!userProfile;
  const isTester = userProfile?.isTester ?? null;
  const createdAt = userProfile?.createdAt ?? null;
  const favoriteCount = userProfile?.favoriteCount ?? null;
  const primaryBoard = toBoardName(homeBoard?.boardType);
  const integrationsConnectedCount = integrationStatuses
    ? integrationStatuses.filter((status) => status.connected).length
    : null;

  // Durable PostHog person properties for cohorting (new-vs-veteran, board-type,
  // tester-vs-regular splits). Own effect, mirroring web's `language` person-
  // property effect, so it only re-fires when one of these traits actually
  // changes rather than on every identity-effect re-run.
  //
  // These carry the account's email, so they must reach PostHog under the
  // account's id and never under whatever id the SDK held before. The profile
  // that fills them is the same one that triggers the identify, so both effects
  // fire in one commit. The callback reconciles first (a no-op when the identity
  // effect already did) and then sends only if the SDK is on this user. That
  // holds whichever effect runs first and whether or not the SDK was loaded.
  useEffect(() => {
    if (isAuthLoading || !analyticsGranted || !isAuthenticated || !hasUserProfile || !authUserId) return;
    return onAnalyticsReady(() => {
      reconcileIdentity();
      if (getAnalyticsIdentity()?.distinctId !== authUserId) return;
      const { set, setOnce } = buildCohortPersonProperties({
        isTester,
        createdAt,
        email: authEmail,
        primaryBoard,
        favoriteCount,
        integrationsConnectedCount,
      });
      setPersonProperties(set, setOnce);
    });
  }, [
    isAuthLoading,
    analyticsGranted,
    isAuthenticated,
    hasUserProfile,
    authUserId,
    reconcileIdentity,
    isTester,
    createdAt,
    favoriteCount,
    primaryBoard,
    integrationsConnectedCount,
    authEmail,
  ]);

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
      authenticatedUserId: isAuthenticated ? (userProfile?.id ?? null) : null,
      isAuthenticated,
      refreshProfile,
    }),
    [
      profile,
      isLoading,
      isAuthenticated,
      refreshProfile,
      userProfile?.id,
      userProfile?.displayName,
      userProfile?.avatarUrl,
    ],
  );

  return <PartyProfileContext.Provider value={value}>{children}</PartyProfileContext.Provider>;
}

export function usePartyProfile(): PartyProfileContextValue {
  const ctx = useContext(PartyProfileContext);
  if (!ctx) throw new Error('usePartyProfile must be used within a PartyProfileProvider');
  return ctx;
}
