import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { router, useSegments } from 'expo-router';
import type { BottomSheetModal } from '@expo/ui/community/bottom-sheet';
import { openDiscordInvite } from '../../lib/discord';
import { reportError } from '../../lib/error-reporting';
import { useAuth } from '../../providers/auth-provider';
import { FeedbackSheet, type FeedbackSheetMode } from './FeedbackSheet';

type BoardReturnTo = '/(tabs)/discover' | '/(tabs)/climbs';

// The drawer panel itself now lives in the `user-drawer` transparentModal route
// (app/user-drawer.tsx). The provider is data + actions only: it opens the route
// and exposes the RAW navigation/feedback actions. The route is responsible for
// sequencing them (its animated `close(after)` runs `after` only once the route's
// view controller has unmounted), so none of these defer on their own.
type UserDrawerContextValue = {
  openUserDrawer: () => void;
  // Kept for type/back-compat. The route owns the animated close; this is a
  // plain pop for any non-route caller (none today — UserAvatarToolbarAction
  // only uses openUserDrawer).
  closeUserDrawer: () => void;
  navigateToBoards: () => void;
  navigateToManageBoards: () => void;
  navigateToSettings: () => void;
  navigateToEditProfile: () => void;
  navigateToPlaylists: () => void;
  navigateToAbout: () => void;
  openDiscord: () => void;
  signOutAction: () => void;
  setFeedbackMode: (mode: FeedbackSheetMode) => void;
  presentFeedback: () => void;
};

const UserDrawerContext = createContext<UserDrawerContextValue | null>(null);

export function useUserDrawer(): UserDrawerContextValue {
  const context = useContext(UserDrawerContext);
  if (!context) throw new Error('useUserDrawer must be used within UserDrawerProvider');
  return context;
}

function currentBoardReturnTo(segments: readonly string[]): BoardReturnTo {
  return segments.includes('discover') ? '/(tabs)/discover' : '/(tabs)/climbs';
}

export function UserDrawerProvider({ children }: { children: ReactNode }) {
  const { signOut } = useAuth();
  const segments = useSegments();
  const feedbackSheetRef = useRef<BottomSheetModal>(null);
  const [feedbackMode, setFeedbackMode] = useState<FeedbackSheetMode>('rating');

  // Mirror the latest focused-route segments into a ref so the callbacks below
  // stay referentially stable (no `segments` in their deps). Assigning during
  // render is the standard "latest value" ref pattern.
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  // The board picker's "return to" is captured when the drawer OPENS — at that
  // moment the underlying tab (discover/climbs) is still focused. Capturing it
  // later, after the drawer route has been popped, would read the wrong segments.
  const returnToRef = useRef<BoardReturnTo>('/(tabs)/climbs');

  const openUserDrawer = useCallback(() => {
    returnToRef.current = currentBoardReturnTo(segmentsRef.current);
    router.push('/user-drawer');
  }, []);

  const closeUserDrawer = useCallback(() => {
    router.back();
  }, []);

  // /boards is a `presentation: 'modal'` route. The route's `close(after)` runs
  // this only after the drawer route has unmounted, so the boards modal never
  // presents over the still-up drawer.
  const navigateToBoards = useCallback(() => {
    router.push({ pathname: '/boards', params: { returnTo: returnToRef.current } });
  }, []);

  // "My Boards" is a management screen (edit / delete owned, unfollow followed),
  // distinct from the board picker that "Change Board" opens.
  const navigateToManageBoards = useCallback(() => {
    router.push('/boards/manage');
  }, []);

  const navigateToSettings = useCallback(() => {
    router.push('/(tabs)/profile/more');
  }, []);

  const navigateToEditProfile = useCallback(() => {
    router.push('/(tabs)/profile/edit');
  }, []);

  const navigateToPlaylists = useCallback(() => {
    router.push('/(tabs)/discover/all');
  }, []);

  const navigateToAbout = useCallback(() => {
    router.push('/about');
  }, []);

  const openDiscord = useCallback(() => {
    void openDiscordInvite('user-drawer');
  }, []);

  const signOutAction = useCallback(() => {
    void signOut('manual').catch(reportError);
  }, [signOut]);

  const presentFeedback = useCallback(() => {
    feedbackSheetRef.current?.present();
  }, []);

  const contextValue = useMemo(
    () => ({
      openUserDrawer,
      closeUserDrawer,
      navigateToBoards,
      navigateToManageBoards,
      navigateToSettings,
      navigateToEditProfile,
      navigateToPlaylists,
      navigateToAbout,
      openDiscord,
      signOutAction,
      setFeedbackMode,
      presentFeedback,
    }),
    [
      openUserDrawer,
      closeUserDrawer,
      navigateToBoards,
      navigateToManageBoards,
      navigateToSettings,
      navigateToEditProfile,
      navigateToPlaylists,
      navigateToAbout,
      openDiscord,
      signOutAction,
      setFeedbackMode,
      presentFeedback,
    ],
  );

  return (
    <UserDrawerContext.Provider value={contextValue}>
      {children}
      {/* FeedbackSheet stays mounted at the provider ROOT — NOT inside the
          user-drawer route. @expo/ui native sheets present off the root window's
          view controller, so a sheet rendered inside the transparentModal drawer
          route would present BEHIND that route and stay hidden. Mounting it here
          and presenting it only after the route has fully unmounted (the route's
          close(after) sequencing) keeps it on top with no concurrent-presentation
          deadlock. */}
      <FeedbackSheet sheetRef={feedbackSheetRef} mode={feedbackMode} />
    </UserDrawerContext.Provider>
  );
}
