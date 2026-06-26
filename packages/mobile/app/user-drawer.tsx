import { useCallback, useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { router } from 'expo-router';
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
 * settle, and runs the optional `after` in THIS screen's unmount cleanup — i.e.
 * once the route's view controller is gone. That ordering is what lets a row
 * navigate or present the (root-mounted) FeedbackSheet without ever stacking a
 * second presentation over the still-up drawer.
 */
export default function UserDrawerScreen() {
  const { t } = useTranslation('common');
  const { t: tSettings } = useTranslation('settings');
  const { systemColors, brandColors } = useTheme();
  const { isAuthenticated } = useAuth();
  const profileQuery = useProfile({ enabled: isAuthenticated });
  const profile = profileQuery.data;
  const insets = useSafeAreaInsets();
  const windowDimensions = useWindowDimensions();
  const drawerWidth = Math.min(DRAWER_MAX_WIDTH, windowDimensions.width * DRAWER_SCREEN_FRACTION);

  const {
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
  } = useUserDrawer();

  const profileDisplayName = profile?.displayName ?? profile?.email ?? t('header.you');
  const profileEmail = profile?.email ?? null;

  const drawerProgress = useSharedValue(0);
  // Queued action to run once THIS route has unmounted (see close). The native
  // FeedbackSheet lives at the provider root and a destination route may itself
  // present a second VC — running them only after the drawer's VC is gone is what
  // keeps two presentations from overlapping and deadlocking UIKit.
  const pendingAfterCloseRef = useRef<(() => void) | null>(null);
  const closingRef = useRef(false);
  // Guards popRoute against firing after this screen has unmounted (an interrupted
  // slide-out's completion callback could otherwise router.back() the wrong route).
  const mountedRef = useRef(true);

  // Slide in on mount.
  useEffect(() => {
    drawerProgress.value = withTiming(1, {
      duration: DRAWER_ANIMATION_MS,
      easing: Easing.out(Easing.cubic),
    });
  }, [drawerProgress]);

  // Fire the queued action once the route's view controller is gone. Deferring it
  // ONE FRAME past unmount is load-bearing: router.back() (the pop) and a deferred
  // native sheet present (FeedbackSheet, off the root window VC) would otherwise
  // land in the SAME native transaction in undefined order — presenting a sheet
  // while the route's VC is still tearing down is exactly the concurrent-
  // presentation deadlock (#3211) this route exists to avoid. The frame yield lets
  // the dismissal flush first. Mirrors the old RN-Modal's requestAnimationFrame.
  useEffect(
    () => () => {
      mountedRef.current = false;
      const after = pendingAfterCloseRef.current;
      pendingAfterCloseRef.current = null;
      if (after) requestAnimationFrame(after);
    },
    [],
  );

  const popRoute = useCallback(() => {
    if (!mountedRef.current) return;
    router.back();
  }, []);

  const close = useCallback(
    (after?: () => void) => {
      if (closingRef.current) return;
      closingRef.current = true;
      if (after) pendingAfterCloseRef.current = after;
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
    [drawerProgress, popRoute],
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

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.backdrop, { backgroundColor: overlays.scrim }, backdropStyle]}>
        <Pressable
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
        <ScrollView
          contentContainerStyle={styles.drawerContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Tappable to edit only when signed in; otherwise a plain header. Both
              branches render the same body, differing only in the wrapper +
              chevron. */}
          {profile?.id ? (
            <Pressable
              style={styles.profileHeader}
              onPress={() => close(() => navigateToEditProfile())}
              accessibilityRole="button"
              accessibilityLabel={tSettings('profile.editAction')}
            >
              <ProfileHeaderBody avatarUrl={profile.avatarUrl} displayName={profileDisplayName} email={profileEmail} />
              <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
            </Pressable>
          ) : (
            <View style={styles.profileHeader}>
              <ProfileHeaderBody avatarUrl={profile?.avatarUrl} displayName={profileDisplayName} email={profileEmail} />
            </View>
          )}

          <View style={[styles.menuGroup, { backgroundColor: systemColors.elevatedSurface }]}>
            <DrawerRow
              icon="boards"
              title={t('userDrawer.changeBoard')}
              onPress={() => close(() => navigateToBoards())}
            />
            <DrawerRow
              icon="boards.fill"
              title={t('myBoards.title')}
              onPress={() => close(() => navigateToManageBoards())}
            />
          </View>

          <View style={[styles.menuGroup, { backgroundColor: systemColors.elevatedSurface }]}>
            <DrawerRow
              icon="settings"
              title={t('ariaLabels.settings')}
              onPress={() => close(() => navigateToSettings())}
            />
            <DrawerRow
              icon="playlist"
              title={t('userDrawer.myPlaylists')}
              onPress={() => close(() => navigateToPlaylists())}
            />
            <DrawerRow
              icon="info"
              title={t('userDrawer.about')}
              onPress={() => close(() => navigateToAbout())}
              showSeparator={false}
            />
          </View>

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
              onPress={() => close(() => signOutAction())}
              showSeparator={false}
            />
          </View>
        </ScrollView>
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
};

function DrawerRow({ icon, title, onPress, showSeparator = true, tintColor }: DrawerRowProps) {
  const { systemColors } = useTheme();
  const iconColor = tintColor ?? systemColors.label;
  return (
    <ListRow
      title={title}
      leading={<Icon name={icon} size={22} color={iconColor} />}
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
});
