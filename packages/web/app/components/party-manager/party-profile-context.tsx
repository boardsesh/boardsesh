'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { type PartyProfile, getPartyProfile, clearPartyProfile, ensurePartyProfile } from '@/app/lib/party-profile-db';
import { alias, identify, reset } from '@/app/lib/analytics';

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
  useEffect(() => {
    if (sessionStatus === 'loading') return;
    const profileId = profile?.id;
    if (!profileId) return;

    if (sessionStatus === 'authenticated' && session?.user?.id) {
      const userId = session.user.id;
      if (lastAnalyticsDistinctId.current === userId) return;
      if (lastAnalyticsDistinctId.current === profileId) {
        alias(userId);
      }
      identify(userId, session.user.email ? { email: session.user.email } : undefined);
      lastAnalyticsDistinctId.current = userId;
      return;
    }

    if (sessionStatus === 'unauthenticated') {
      if (lastAnalyticsDistinctId.current === profileId) return;
      if (lastAnalyticsDistinctId.current && lastAnalyticsDistinctId.current !== profileId) {
        reset();
      }
      identify(profileId);
      lastAnalyticsDistinctId.current = profileId;
    }
  }, [profile?.id, sessionStatus, session?.user?.id, session?.user?.email]);

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
