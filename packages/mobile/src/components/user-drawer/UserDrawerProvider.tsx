import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSegments } from 'expo-router';
import { Platform } from 'react-native';
import { scopedRouter as router } from '../../lib/routing/scoped-navigation';
import { openDiscordInvite } from '../../lib/discord';
import { useConfirmSignOut } from '../../hooks/use-confirm-sign-out';
import type { ManagedSheetHandle } from '../../providers/sheet-presentation-provider';
import { FeedbackSheet, type FeedbackSheetMode } from './FeedbackSheet';
import { QaVerdictSheet } from './QaVerdictSheet';

type BoardReturnTo = '/(tabs)/discover' | '/(tabs)/climbs';

// The drawer panel itself now lives in the `user-drawer` transparentModal route
// (app/user-drawer.tsx). The provider is data + actions only: it opens the route
// and exposes the RAW navigation/feedback actions. The route is responsible for
// sequencing them (its animated `close(after)` queues `after` following React
// unmount), so none of these defer on their own.
type UserDrawerContextValue = {
  openUserDrawer: () => void;
  // Kept for type/back-compat. The route owns the animated close; this is a
  // plain pop for any non-route caller (none today — UserAvatarToolbarAction
  // only uses openUserDrawer).
  closeUserDrawer: () => void;
  navigateToBoards: () => void;
  navigateToSettings: () => void;
  navigateToEditProfile: () => void;
  navigateToPlaylists: () => void;
  /** The gyms the signed-in climber runs. */
  navigateToMyGyms: () => void;
  /** The community moderation feed, a root modal. */
  navigateToModeration: () => void;
  navigateToChangelog: () => void;
  navigateToAbout: () => void;
  openDiscord: () => void;
  signOutAction: (signal?: AbortSignal) => Promise<void>;
  setFeedbackMode: (mode: FeedbackSheetMode) => void;
  presentFeedback: () => void;
  /** Crowdsourced QA (tester-only): the list of PR previews this build can load. */
  navigateToQaPick: () => void;
  /** Crowdsourced QA (tester-only): what to test on the preview already running. */
  navigateToQaBrief: () => void;
  /** Crowdsourced QA (tester-only): approve / decline the running preview. */
  presentQaVerdict: () => void;
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
  const confirmSignOut = useConfirmSignOut();
  const segments = useSegments();
  const feedbackSheetRef = useRef<ManagedSheetHandle>(null);
  const qaVerdictSheetRef = useRef<ManagedSheetHandle>(null);
  const [feedbackMode, setFeedbackMode] = useState<FeedbackSheetMode>('rating');
  const [feedbackVisible, setFeedbackVisible] = useState(false);

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
    router.push(Platform.OS === 'ios' ? '/account' : '/user-drawer');
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

  const navigateToSettings = useCallback(() => {
    router.push('/settings');
  }, []);

  const navigateToEditProfile = useCallback(() => {
    router.push('/settings/edit');
  }, []);

  const navigateToPlaylists = useCallback(() => {
    router.navigate('/(tabs)/discover/all');
  }, []);

  const navigateToMyGyms = useCallback(() => {
    router.push('/gyms/mine');
  }, []);

  // A root modal (one copy, not one per tab), so it presents above whatever is
  // open, once the drawer route is gone.
  const navigateToModeration = useCallback(() => {
    router.push('/moderation');
  }, []);

  const navigateToChangelog = useCallback(() => {
    router.push('/changelog');
  }, []);

  const navigateToAbout = useCallback(() => {
    router.push('/about');
  }, []);

  const openDiscord = useCallback(() => {
    void openDiscordInvite('user-drawer');
  }, []);

  // The drawer confirms after closing. iOS Account confirms while mounted so its
  // modal dismissal cannot race the native confirmation sheet (#6505). The shared
  // hook owns confirmation, double-tap protection and retry after cancel/failure.
  // Account can cancel warning probes when it closes, before a dialog is shown.
  // This row used to call `signOut` straight through: one tap discarded the downloaded
  // boards and any unsynced writes with no warning at all (issue #3621).
  const signOutAction = useCallback((signal?: AbortSignal) => confirmSignOut(signal), [confirmSignOut]);

  const presentFeedback = useCallback(() => {
    setFeedbackVisible(true);
  }, []);

  const closeFeedback = useCallback(() => {
    setFeedbackVisible(false);
  }, []);

  const navigateToQaPick = useCallback(() => {
    router.push('/qa/pick');
  }, []);

  const navigateToQaBrief = useCallback(() => {
    router.push('/qa/brief');
  }, []);

  const presentQaVerdict = useCallback(() => {
    qaVerdictSheetRef.current?.present();
  }, []);

  const contextValue = useMemo(
    () => ({
      openUserDrawer,
      closeUserDrawer,
      navigateToBoards,
      navigateToSettings,
      navigateToEditProfile,
      navigateToPlaylists,
      navigateToMyGyms,
      navigateToModeration,
      navigateToChangelog,
      navigateToAbout,
      openDiscord,
      signOutAction,
      setFeedbackMode,
      presentFeedback,
      navigateToQaPick,
      navigateToQaBrief,
      presentQaVerdict,
    }),
    [
      openUserDrawer,
      closeUserDrawer,
      navigateToBoards,
      navigateToSettings,
      navigateToEditProfile,
      navigateToPlaylists,
      navigateToMyGyms,
      navigateToModeration,
      navigateToChangelog,
      navigateToAbout,
      openDiscord,
      signOutAction,
      setFeedbackMode,
      presentFeedback,
      navigateToQaPick,
      navigateToQaBrief,
      presentQaVerdict,
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
      <FeedbackSheet
        sheetRef={feedbackSheetRef}
        mode={feedbackMode}
        visible={feedbackVisible}
        onClose={closeFeedback}
      />
      {/* Same root-hosting rule as FeedbackSheet above: a native sheet rendered
          inside the transparentModal drawer route would present behind it. */}
      <QaVerdictSheet sheetRef={qaVerdictSheetRef} />
    </UserDrawerContext.Provider>
  );
}
