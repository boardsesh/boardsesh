'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { type PartyProfile, getPartyProfile, clearPartyProfile, ensurePartyProfile } from '@/app/lib/party-profile-db';
import { reconcileAnalyticsIdentity } from '@boardsesh/analytics';
import { alias, identify, reset, setPersonProperties, track } from '@/app/lib/analytics';
import { isAdminAnalyticsUrl } from '@/app/lib/analytics-paths';
import { hasRecordedPosthogAlias, recordPosthogAlias } from '@/app/lib/posthog-alias-storage';
import { consumeFreshOAuthPending } from '@/app/lib/oauth-pending-db';

type UserProfileData = {
  displayName: string | null;
  avatarUrl: string | null;
};

type PartyProfileContextType = {
  profile: PartyProfile | null;
  isLoading: boolean;
  hasProfile: boolean;
  // Username and avatar - prefer custom profile over NextAuth session
  username: string | undefined;
  avatarUrl: string | undefined;
  isAuthenticated: boolean;
  clearProfile: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const PartyProfileContext = createContext<PartyProfileContextType | undefined>(undefined);

export const PartyProfileProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [profile, setProfile] = useState<PartyProfile | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfileData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { data: session, status: sessionStatus } = useSession();
  const pathname = usePathname();
  const { i18n } = useTranslation();
  const lastAnalyticsDistinctId = useRef<string | null>(null);

  // Load party profile on mount
  useEffect(() => {
    let mounted = true;

    const loadProfile = async () => {
      try {
        // This will migrate from localStorage if needed and create a profile if none exists
        const loadedProfile = await ensurePartyProfile();
        if (mounted) {
          setProfile(loadedProfile);
        }
      } catch (error) {
        console.error('Failed to load party profile:', error);
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };

    void loadProfile();

    return () => {
      mounted = false;
    };
  }, []);

  // Wire PostHog identity so anonymous → authenticated cohorts merge for D30
  // retention. The IndexedDB party-profile UUID is the anonymous distinct_id;
  // on login we alias it to session.user.id then switch identity. PostHog
  // server-side merges historical anonymous events into the authed user.
  // There is still a short cold-load gap before IndexedDB resolves the profile;
  // events in that gap use PostHog's temporary in-memory anonymous ID.
  useEffect(() => {
    if (sessionStatus === 'loading') return;
    if (pathname && isAdminAnalyticsUrl(pathname)) return;
    const profileId = profile?.id;
    if (!profileId) return;

    const userId = session?.user?.id ?? null;
    const previousDistinctId = lastAnalyticsDistinctId.current;
    // True exactly on the run that transitions into an authenticated identity —
    // used to fire the OAuth-pending drain once (mirrors the prior inline guard).
    const justAuthenticated = sessionStatus === 'authenticated' && !!userId && previousDistinctId !== userId;

    // Pure anon → authed reconciliation shared with mobile. Drives reset /
    // identify(anon) / alias(user) / identify(user, {email}) and dedupes the
    // alias pair via posthog-alias-storage.
    lastAnalyticsDistinctId.current = reconcileAnalyticsIdentity({
      profileId,
      authUserId: userId,
      authEmail: session?.user?.email ?? null,
      isAuthenticated: sessionStatus === 'authenticated',
      lastDistinctId: previousDistinctId,
      client: { identify, alias, reset },
      aliasStore: { hasRecordedAlias: hasRecordedPosthogAlias, recordAlias: recordPosthogAlias },
    });

    if (justAuthenticated) {
      // Drain the OAuth-pending marker (if any) — this is the success signal
      // for OAuth flows where the actual sign-in happens via a server-side
      // redirect with no client callback to track from. Marker is set on
      // OAuth button click in social-login-buttons.tsx and expires after 5
      // minutes so an unrelated re-login won't fire a stale Login Succeeded.
      void consumeFreshOAuthPending().then((marker) => {
        if (marker) {
          track('Login Succeeded', {
            auth_method: marker.provider,
            flow: marker.flow,
          });
        }
      });
    }
  }, [pathname, profile?.id, sessionStatus, session?.user?.id, session?.user?.email]);

  // Keep PostHog's `language` person property in sync with the active locale.
  // Scoped to its own effect so it only fires when the language actually
  // changes — not on every navigation (the identity effect above re-runs on
  // pathname changes, which would be wasteful for a property that rarely
  // changes).
  //
  // Guards mirror the identity effect above: skip while session status is still
  // loading or before the IDB profile resolves (otherwise we'd attach `language`
  // to PostHog's transient anon id and have to merge it later), and skip on
  // admin URLs to keep admin sessions out of analytics entirely.
  useEffect(() => {
    if (sessionStatus === 'loading') return;
    if (pathname && isAdminAnalyticsUrl(pathname)) return;
    if (!profile?.id) return;
    setPersonProperties({ language: i18n.language });
  }, [i18n.language, pathname, profile?.id, sessionStatus]);

  // Fetch custom user profile (displayName, avatarUrl) when authenticated
  useEffect(() => {
    let mounted = true;

    const fetchUserProfile = async () => {
      if (sessionStatus !== 'authenticated') {
        setUserProfile(null);
        return;
      }

      try {
        const response = await fetch('/api/internal/profile');
        if (response.ok) {
          const data = await response.json();
          if (mounted) {
            setUserProfile(data.profile || null);
          }
        }
      } catch (error) {
        console.error('Failed to fetch user profile:', error);
      }
    };

    void fetchUserProfile();

    return () => {
      mounted = false;
    };
  }, [sessionStatus]);

  const refreshProfile = useCallback(async () => {
    try {
      // Refresh party profile from IndexedDB
      const loadedProfile = await getPartyProfile();
      setProfile(loadedProfile);

      // Also refresh user profile from API if authenticated
      if (sessionStatus === 'authenticated') {
        const response = await fetch('/api/internal/profile');
        if (response.ok) {
          const data = await response.json();
          setUserProfile(data.profile || null);
        }
      }
    } catch (error) {
      console.error('Failed to refresh party profile:', error);
    }
  }, [sessionStatus]);

  const clearProfileHandler = useCallback(async () => {
    setIsLoading(true);
    try {
      await clearPartyProfile();
      // Create a new empty profile
      const newProfile = await ensurePartyProfile();
      setProfile(newProfile);
    } catch (error) {
      console.error('Failed to clear party profile:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const hasProfile = useMemo(() => !!profile?.id, [profile?.id]);

  // Username and avatar - prefer custom profile over NextAuth session
  const username = useMemo(
    () => userProfile?.displayName || session?.user?.name || undefined,
    [userProfile?.displayName, session?.user?.name],
  );
  const avatarUrl = useMemo(
    () => userProfile?.avatarUrl || session?.user?.image || undefined,
    [userProfile?.avatarUrl, session?.user?.image],
  );
  const isAuthenticated = useMemo(() => sessionStatus === 'authenticated', [sessionStatus]);

  const value = useMemo<PartyProfileContextType>(
    () => ({
      profile,
      isLoading,
      hasProfile,
      username,
      avatarUrl,
      isAuthenticated,
      clearProfile: clearProfileHandler,
      refreshProfile,
    }),
    [profile, isLoading, hasProfile, username, avatarUrl, isAuthenticated, clearProfileHandler, refreshProfile],
  );

  return <PartyProfileContext.Provider value={value}>{children}</PartyProfileContext.Provider>;
};

export const usePartyProfile = (): PartyProfileContextType => {
  const context = useContext(PartyProfileContext);
  if (!context) {
    throw new Error('usePartyProfile must be used within a PartyProfileProvider');
  }
  return context;
};

export type { PartyProfileContextType };
