import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { latestEntryDate } from '../src/lib/changelog';
import { getLastSeenChangelogDate, hasUnseenChangelog } from '../src/lib/changelog-seen';
import { hasUnseenOfflineSpotlight } from '../src/lib/offline-nudges/spotlight-unseen';
import { useOfflineDownloadsEnabled, useOfflineNudgesEnabled } from '../src/providers/feature-flags-provider';
import { useActiveBoard } from '../src/lib/graphql/use-active-board';
import { useOtaBranchSurfingState } from '../src/lib/ota-branch-surfing-state';
import { readRunningPrNumber } from '../src/lib/qa/qa-surf';
import { runningQaPrNumberToOffer } from '../src/lib/qa/qa-drawer-rows';

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

  // Whether the bundled changelog has an entry the user hasn't opened yet — drives
  // the "New" pill on the What's New row. The drawer is a fresh route push every
  // time it opens, so a one-shot mount read is enough; opening the changelog clears
  // the marker and the next drawer open re-reads it.
  // ...OR'd with the curated offline spotlight pinned inside that screen, which
  // is otherwise unreachable for anyone whose changelog is already read — but
  // ONLY when that card can actually render. Both flags gate the card itself, so
  // without this the pill would light for every user with nothing downloaded
  // while the nudge flag sits at 0%, and opening What's New would never clear it
  // (the card never renders, so its "shown" marker is never written). The active
  // board is the same kind of precondition: the card names a board, so someone
  // who has never picked one would carry the pill forever.
  const offlineEngineEnabled = useOfflineDownloadsEnabled();
  const offlineNudgesEnabled = useOfflineNudgesEnabled();
  const { data: activeBoard } = useActiveBoard();
  const spotlightReachable = offlineEngineEnabled && offlineNudgesEnabled && !!activeBoard;
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

  // Crowdsourced QA (docs/crowdsourced-qa-mobile.md). Testers only, and only on a
  // binary that can actually load a PR preview — on any other build the rows
  // would offer something the app cannot do. The running branch cannot change
  // without a reload, so a mount-time read is the whole story.
  const { surfingBuild: qaSurfingBuild } = useOtaBranchSurfingState();
  const showQaRows = Boolean(profile?.isTester) && qaSurfingBuild;
  // The running branch cannot change without a reload, so it is read once. Which
  // rows it earns is re-derived from the signed-in account: the markers are
  // account-scoped, so tester A's sign-off must not follow tester B onto the
  // same device.
  const [qaRunningPrNumber] = useState(() => readRunningPrNumber());
  // Null once THIS account has filed a verdict for THIS bundle, which switches
  // the group back to "Test a PR preview": leaving a preview usually cannot
  // reload the app (docs/crowdsourced-qa-mobile.md), so without the marker the
  // drawer would keep offering to finish testing something already signed off.
  const qaPrNumber = useMemo(
    () => runningQaPrNumberToOffer(qaRunningPrNumber, profile?.id),
    [qaRunningPrNumber, profile?.id],
  );

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
            {/* One row, not two: "Change board" and "My Boards" were adjacent
                entries with the same glyph and the same chevron, and nothing on
                screen said which one edited a board and which one switched to it
                (#4623). /boards now does both. */}
            <DrawerRow
              icon="boards"
              title={t('userDrawer.changeBoard')}
              onPress={() => close(() => navigateToBoards())}
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
                    // i18n-ignore-next-line — tester-only QA flow
                    title={`Finish testing #${qaPrNumber}`}
                    onPress={() => close(() => presentQaVerdict())}
                    trailing={
                      <View style={[styles.newPill, { backgroundColor: brandColors.primaryFill }]}>
                        <Text variant="caption2" color={brandColors.onPrimary} style={styles.newPillLabel}>
                          {/* i18n-ignore-next-line */}
                          QA
                        </Text>
                      </View>
                    }
                  />
                  <DrawerRow
                    icon="doc.text"
                    // i18n-ignore-next-line
                    title={`Test plan #${qaPrNumber}`}
                    onPress={() => close(() => navigateToQaBrief())}
                    showSeparator={false}
                  />
                </>
              ) : (
                <DrawerRow
                  icon="branch"
                  // i18n-ignore-next-line
                  title="Test a PR preview"
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
