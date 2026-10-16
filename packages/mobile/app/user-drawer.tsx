import { PressableSurface } from '../src/components/PressableSurface';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Stack, router, useNavigation, type NativeStackNavigationProp } from 'expo-router';
import { HeaderLeadingButton } from '../src/components/HeaderActionButtons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useProfile } from '../src/lib/graphql/hooks';
import { useAuth } from '../src/providers/auth-provider';
import { useTheme } from '../src/providers/theme-provider';
import { spacing, borderRadius, shadows, overlays } from '../src/theme/tokens';
import type { IconName } from '../src/components/icon-map';
import { Avatar } from '../src/components/Avatar';
import { Text } from '../src/components/Text';
import { Icon } from '../src/components/Icon';
import { ListRow } from '../src/components/ListRow';
import { useUserDrawer } from '../src/components/user-drawer/UserDrawerProvider';
import { latestEntryDate } from '../src/lib/changelog';
import { getLastSeenChangelogDate, hasUnseenChangelog } from '../src/lib/changelog-seen';
import { hasUnseenOfflineSpotlight } from '../src/lib/offline-nudges/spotlight-unseen';
import { useClimbModerationEnabled, useOfflineDownloadsEnabled } from '../src/providers/feature-flags-provider';
import { useActiveBoard } from '../src/lib/graphql/use-active-board';
import { useQaMenu } from '../src/lib/qa/use-qa-menu';
import { holdUntilLaunchReady } from '../src/components/launch-update/hold-until-launch-ready';

const DRAWER_MAX_WIDTH = 320;
const DRAWER_SCREEN_FRACTION = 0.86;
const DRAWER_ANIMATION_MS = 220;

/**
 * User drawer route (`presentation: 'transparentModal'`, registered in
 * app/_layout.tsx). Replaces the old RN-core `<Modal>` that UserDrawerProvider
 * used to render: a real route is a single native presentation system, so it no
 * longer collides with the @expo/ui FeedbackSheet (the dual-presentation freeze,
 * issue #3211).
 *
 * The panel runs its OWN reanimated slide (the route is registered with
 * `animation: 'none'`). `close(after)` slides the panel out, pops the route on
 * settle, and queues the optional `after` one frame after React unmounts. That
 * ordering lets a row navigate or present the root-mounted FeedbackSheet without stacking a
 * second presentation over the still-up drawer.
 */
export function UserDrawerScreen({ presentation = 'drawer' }: { presentation?: 'drawer' | 'account' }) {
  const isAccount = presentation === 'account';
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, undefined>>>();
  const { t } = useTranslation('common');
  const { t: tSettings } = useTranslation('settings');
  const { systemColors, brandColors } = useTheme();
  const { isAuthenticated } = useAuth();
  const profileQuery = useProfile({ enabled: isAuthenticated });
  const profile = profileQuery.data;
  const insets = useSafeAreaInsets();
  const windowDimensions = useWindowDimensions();
  const drawerWidth = Math.min(DRAWER_MAX_WIDTH, windowDimensions.width * DRAWER_SCREEN_FRACTION);

  // Whether the bundled changelog has an entry the user hasn't opened yet — drives
  // the "New" pill on the What's New row. The drawer is a fresh route push every
  // time it opens, so a one-shot mount read is enough; opening the changelog clears
  // the marker and the next drawer open re-reads it.
  // ...OR'd with the curated offline spotlight pinned inside that screen, which
  // is otherwise unreachable for anyone whose changelog is already read — but
  // ONLY when that card can actually render, or the pill would light with no way
  // to clear it (the card never renders, so its "shown" marker is never
  // written). The engine gate is the card's own: on the Expo web fork there is
  // no download to offer. The active board is the same kind of precondition —
  // the card names a board, so someone who has never picked one would carry the
  // pill forever.
  const offlineEngineEnabled = useOfflineDownloadsEnabled();
  // Kill switch for the whole community-moderation surface. Off hides the way in.
  const climbModerationEnabled = useClimbModerationEnabled();
  const { data: activeBoard } = useActiveBoard();
  const spotlightReachable = offlineEngineEnabled && !!activeBoard;
  const [changelogUnseen, setChangelogUnseen] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([
      getLastSeenChangelogDate(),
      spotlightReachable ? hasUnseenOfflineSpotlight() : Promise.resolve(false),
    ]).then(([lastSeen, spotlightUnseen]) => {
      if (active) setChangelogUnseen(hasUnseenChangelog(latestEntryDate, lastSeen) || spotlightUnseen);
    });
    return () => {
      active = false;
    };
  }, [spotlightReachable]);

  const {
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
  } = useUserDrawer();

  // Crowdsourced QA (docs/crowdsourced-qa-mobile.md). Open to every user on a
  // binary that can actually load a PR preview — on any other build the rows
  // would offer something the app cannot do. `qaPrNumber` is null once THIS
  // account has filed a verdict for THIS bundle, which switches the group back to
  // "Test a PR preview": leaving a preview usually cannot reload the app, so
  // without the marker the drawer would keep offering to finish testing something
  // already signed off.
  const { show: showQaRows, prNumber: qaPrNumber } = useQaMenu();

  const profileDisplayName = profile?.displayName ?? profile?.email ?? t('header.you');
  const profileEmail = profile?.email ?? null;

  const drawerProgress = useSharedValue(0);
  // Queued action to run after THIS route has unmounted (see close). The native
  // FeedbackSheet lives at the provider root; drawer actions defer presentation
  // so they do not start during the drawer's slide-out.
  const pendingAfterCloseRef = useRef<(() => void) | null>(null);
  const closingRef = useRef(false);
  const signOutPreparationRef = useRef<AbortController | null>(null);
  // Guards popRoute against firing after this screen has unmounted (an interrupted
  // slide-out's completion callback could otherwise router.back() the wrong route).
  const mountedRef = useRef(true);
  const cancelSignOutPreparation = useCallback(() => {
    signOutPreparationRef.current?.abort();
    signOutPreparationRef.current = null;
  }, []);

  useEffect(() => {
    if (!isAccount || Platform.OS !== 'ios') return;
    // Account's index is nested inside its own stack. Its parent navigation
    // owns the native modal dismissal, including an interactive swipe.
    const accountNavigation = navigation.getParent<NativeStackNavigationProp<Record<string, undefined>>>();
    const unsubscribeBlur = navigation.addListener('blur', cancelSignOutPreparation);
    const unsubscribeClosing = accountNavigation?.addListener('transitionStart', ({ data: { closing } }) => {
      if (!closing) return;
      closingRef.current = true;
      cancelSignOutPreparation();
    });
    const unsubscribeGestureCancel = accountNavigation?.addListener('gestureCancel', () => {
      closingRef.current = false;
    });
    const unsubscribeOpening = accountNavigation?.addListener('transitionEnd', ({ data: { closing } }) => {
      if (!closing) closingRef.current = false;
    });
    return () => {
      unsubscribeBlur();
      unsubscribeClosing?.();
      unsubscribeGestureCancel?.();
      unsubscribeOpening?.();
      cancelSignOutPreparation();
    };
  }, [cancelSignOutPreparation, isAccount, navigation]);

  // Slide in on mount.
  useEffect(() => {
    if (isAccount) return;
    drawerProgress.value = withTiming(1, {
      duration: DRAWER_ANIMATION_MS,
      easing: Easing.out(Easing.cubic),
    });
  }, [drawerProgress, isAccount]);

  // Defer drawer actions one frame past React unmount to separate the pop and
  // presentation transactions (#3211). React unmount does not guarantee native
  // dismissal has completed: iOS Account sign-out confirms while Account stays
  // mounted instead of relying on this frame to finish its modal dismissal.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelSignOutPreparation();
      const after = pendingAfterCloseRef.current;
      pendingAfterCloseRef.current = null;
      if (after) requestAnimationFrame(after);
    };
  }, [cancelSignOutPreparation]);

  const popRoute = useCallback(() => {
    if (!mountedRef.current) return;
    router.back();
  }, []);

  const close = useCallback(
    (after?: () => void) => {
      if (closingRef.current) return;
      closingRef.current = true;
      if (after) pendingAfterCloseRef.current = after;
      if (isAccount) {
        cancelSignOutPreparation();
        popRoute();
        return;
      }
      drawerProgress.value = withTiming(
        0,
        {
          duration: DRAWER_ANIMATION_MS,
          easing: Easing.out(Easing.cubic),
        },
        // Pop whenever the slide-out settles — not only on finished===true. A
        // completion reported as unfinished would otherwise strand the route
        // mounted with its full-screen (opacity-0 but still hit-testing) backdrop
        // eating every tap; popRoute's mountedRef guard keeps an after-unmount
        // callback from popping the wrong route.
        () => {
          runOnJS(popRoute)();
        },
      );
    },
    [cancelSignOutPreparation, drawerProgress, popRoute, isAccount],
  );

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: drawerProgress.value,
  }));

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -drawerWidth + drawerWidth * drawerProgress.value }],
  }));

  const handleRate = () => {
    // Set the mode now (not in the deferred callback) so the root FeedbackSheet
    // has re-rendered with it well before the deferred present() fires.
    setFeedbackMode('rating');
    close(() => presentFeedback());
  };

  const handleReportBug = () => {
    setFeedbackMode('bug');
    close(() => presentFeedback());
  };

  const handleSignOut = () => {
    if (isAccount && Platform.OS === 'ios') {
      // Present from the stable Account sheet. Dismissing it first can race the
      // native confirmation sheet (#6505). Cancel/failure keeps this row usable;
      // successful sign-out redirects through AuthProvider.
      if (!mountedRef.current || closingRef.current || !navigation.isFocused() || signOutPreparationRef.current) return;
      const controller = new AbortController();
      signOutPreparationRef.current = controller;
      void signOutAction(controller.signal).finally(() => {
        if (signOutPreparationRef.current === controller) signOutPreparationRef.current = null;
      });
      return;
    }
    close(() => signOutAction());
  };

  const menuContent = (
    <ScrollView
      contentContainerStyle={[
        styles.drawerContent,
        isAccount && { paddingTop: spacing[4], paddingBottom: insets.bottom + spacing[4] },
      ]}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {/* Tappable to edit only when signed in; otherwise a plain header. Both
              branches render the same body, differing only in the wrapper +
              chevron. */}
      {profile?.id ? (
        <PressableSurface
          style={styles.profileHeader}
          onPress={() => (isAccount ? router.push('/account/settings/edit') : close(() => navigateToEditProfile()))}
          accessibilityRole="button"
          accessibilityLabel={tSettings('profile.editAction')}
        >
          <ProfileHeaderBody avatarUrl={profile.avatarUrl} displayName={profileDisplayName} email={profileEmail} />
          <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
        </PressableSurface>
      ) : (
        <View style={styles.profileHeader}>
          <ProfileHeaderBody avatarUrl={profile?.avatarUrl} displayName={profileDisplayName} email={profileEmail} />
        </View>
      )}

      <View style={[styles.menuGroup, { backgroundColor: systemColors.elevatedSurface }]}>
        {/* One row, not two: "Change board" and "My Boards" were adjacent
                entries with the same glyph and the same chevron, and nothing on
                screen said which one edited a board and which one switched to it
                (#4623). /boards now does both. */}
        <DrawerRow icon="boards" title={t('userDrawer.changeBoard')} onPress={() => close(() => navigateToBoards())} />
      </View>

      <View style={[styles.menuGroup, { backgroundColor: systemColors.elevatedSurface }]}>
        <DrawerRow
          icon="settings"
          title={t('ariaLabels.settings')}
          onPress={() => (isAccount ? router.push('/account/settings') : close(() => navigateToSettings()))}
        />
        <DrawerRow
          icon="playlist"
          title={t('userDrawer.myPlaylists')}
          onPress={() => close(() => navigateToPlaylists())}
        />
        {/* The gyms you run. Signed in only: the list is scoped to the caller. */}
        {isAuthenticated ? (
          <DrawerRow
            icon="gym"
            title={t('boards:mobile.myGyms.moreRowTitle')}
            onPress={() => close(() => navigateToMyGyms())}
          />
        ) : null}
        {/* Not gated on sign-in: anyone can read what the crew is deciding, and
                the vote buttons handle the signed-out case themselves. */}
        {climbModerationEnabled ? (
          <DrawerRow
            icon="moderation"
            title={t('climbs:mobile.moderation.title')}
            onPress={() => close(() => navigateToModeration())}
          />
        ) : null}
        {/* No subtitle: drawer rows are single-line menu entries (Settings,
                About, …); the "Recent updates and fixes" line lives on the
                changelog screen itself. The "New" pill carries the unseen cue. */}
        <DrawerRow
          icon="changelog"
          title={t('userDrawer.whatsNew')}
          onPress={() => close(() => navigateToChangelog())}
          trailing={
            changelogUnseen ? (
              <View style={[styles.newPill, { backgroundColor: brandColors.primaryFill }]}>
                <Text variant="caption2" color={brandColors.onPrimary} style={styles.newPillLabel}>
                  {t('userDrawer.newBadge')}
                </Text>
              </View>
            ) : undefined
          }
        />
        <DrawerRow
          icon="info"
          title={t('userDrawer.about')}
          onPress={() => close(() => navigateToAbout())}
          showSeparator={false}
        />
      </View>

      {showQaRows ? (
        <View style={[styles.menuGroup, { backgroundColor: systemColors.elevatedSurface }]}>
          {qaPrNumber !== null ? (
            <>
              <DrawerRow
                icon="checkmark.circle.fill"
                title={t('userDrawer.qa.finishTesting', { prNumber: qaPrNumber })}
                onPress={() => close(() => presentQaVerdict())}
                trailing={
                  <View style={[styles.newPill, { backgroundColor: brandColors.primaryFill }]}>
                    <Text variant="caption2" color={brandColors.onPrimary} style={styles.newPillLabel}>
                      {t('userDrawer.qa.badge')}
                    </Text>
                  </View>
                }
              />
              <DrawerRow
                icon="doc.text"
                title={t('userDrawer.qa.testPlan', { prNumber: qaPrNumber })}
                onPress={() => close(() => navigateToQaBrief())}
                showSeparator={false}
              />
            </>
          ) : (
            <DrawerRow
              icon="branch"
              title={t('userDrawer.qa.pick')}
              onPress={() => close(() => navigateToQaPick())}
              showSeparator={false}
            />
          )}
        </View>
      ) : null}

      <View style={[styles.menuGroup, { backgroundColor: systemColors.elevatedSurface }]}>
        <DrawerRow icon="star" title={t('userDrawer.rateBoardsesh')} onPress={handleRate} />
        <DrawerRow icon="flag" title={t('userDrawer.reportBug')} onPress={handleReportBug} />
        <DrawerRow
          icon="open.external"
          title={t('userDrawer.joinDiscord')}
          tintColor={brandColors.primary}
          onPress={() => close(() => openDiscord())}
          showSeparator={false}
        />
      </View>

      <View style={[styles.menuGroup, { backgroundColor: systemColors.elevatedSurface }]}>
        <DrawerRow
          icon="logout"
          title={t('userDrawer.logout')}
          tintColor={brandColors.error}
          onPress={handleSignOut}
          showSeparator={false}
        />
      </View>
    </ScrollView>
  );

  if (isAccount) {
    return (
      <View style={[styles.root, { backgroundColor: systemColors.secondaryBackground }]}>
        <Stack.Screen
          options={{
            title: t('userDrawer.accountTitle'),
            headerRight: () => <HeaderLeadingButton kind="close" onPress={() => close()} />,
          }}
        />
        {menuContent}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.backdrop, { backgroundColor: overlays.scrim }, backdropStyle]}>
        <PressableSurface
          style={StyleSheet.absoluteFill}
          onPress={() => close()}
          accessibilityRole="button"
          accessibilityLabel={t('ariaLabels.close')}
        />
      </Animated.View>
      <Animated.View
        style={[
          styles.drawer,
          {
            width: drawerWidth,
            paddingTop: insets.top + spacing[4],
            paddingBottom: insets.bottom + spacing[4],
            backgroundColor: systemColors.secondaryBackground,
            borderRightColor: systemColors.separator,
          },
          shadows.lg,
          drawerStyle,
        ]}
      >
        {menuContent}
      </Animated.View>
    </View>
  );
}

type ProfileHeaderBodyProps = {
  avatarUrl: string | null | undefined;
  displayName: string;
  email: string | null;
};

// The avatar + name + email block shared by the tappable (signed-in) and plain
// (signed-out) header variants, so the markup lives in one place.
function ProfileHeaderBody({ avatarUrl, displayName, email }: ProfileHeaderBodyProps) {
  const { systemColors } = useTheme();
  return (
    <>
      <Avatar uri={avatarUrl} name={displayName} size={60} />
      <View style={styles.profileText}>
        <Text variant="headline" numberOfLines={1} style={styles.profileName}>
          {displayName}
        </Text>
        {email ? (
          <Text variant="subheadline" color={systemColors.secondaryLabel} numberOfLines={1}>
            {email}
          </Text>
        ) : null}
      </View>
    </>
  );
}

type DrawerRowProps = {
  icon: IconName;
  title: string;
  onPress: () => void;
  showSeparator?: boolean;
  tintColor?: string;
  trailing?: ReactNode;
};

function DrawerRow({ icon, title, onPress, showSeparator = true, tintColor, trailing }: DrawerRowProps) {
  const { systemColors } = useTheme();
  const iconColor = tintColor ?? systemColors.label;
  return (
    <ListRow
      title={title}
      leading={<Icon name={icon} size={22} color={iconColor} />}
      trailing={trailing}
      showChevron
      showSeparator={showSeparator}
      separatorInset={16}
      onPress={onPress}
      accessibilityLabel={title}
      style={styles.drawerRow}
    />
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  drawer: {
    height: '100%',
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  drawerContent: {
    paddingHorizontal: spacing[3],
    gap: spacing[3],
  },
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[2],
    paddingBottom: spacing[3],
  },
  profileText: {
    flex: 1,
    minWidth: 0,
  },
  profileName: {
    fontWeight: '700',
  },
  menuGroup: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
  },
  drawerRow: {
    minHeight: 48,
  },
  newPill: {
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  newPillLabel: {
    fontWeight: '700',
    textTransform: 'uppercase',
  },
});

// iOS presents this route as a native modal, above the launch update
// placeholder, and a URL can open it on a cold start. Held until launch is
// ready so a gate reload cannot land mid-tap (#6006).
export default holdUntilLaunchReady(UserDrawerScreen);
