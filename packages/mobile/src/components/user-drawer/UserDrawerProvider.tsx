import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { router, useSegments } from 'expo-router';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { openDiscordInvite } from '../../lib/discord';
import { reportError } from '../../lib/error-reporting';
import { useProfile } from '../../lib/graphql/hooks';
import { useAuth } from '../../providers/auth-provider';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius, shadows, overlays } from '../../theme/tokens';
import type { IconName } from '../icon-map';
import { Avatar } from '../Avatar';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { ListRow } from '../ListRow';
import { FeedbackSheet, type FeedbackSheetMode } from './FeedbackSheet';

type UserDrawerContextValue = {
  openUserDrawer: () => void;
  closeUserDrawer: () => void;
};

const UserDrawerContext = createContext<UserDrawerContextValue | null>(null);
const DRAWER_MAX_WIDTH = 320;
const DRAWER_SCREEN_FRACTION = 0.86;
const DRAWER_ANIMATION_MS = 220;

export function useUserDrawer(): UserDrawerContextValue {
  const context = useContext(UserDrawerContext);
  if (!context) throw new Error('useUserDrawer must be used within UserDrawerProvider');
  return context;
}

function currentBoardReturnTo(segments: readonly string[]): '/(tabs)/discover' | '/(tabs)/climbs' {
  return segments.includes('discover') ? '/(tabs)/discover' : '/(tabs)/climbs';
}

export function UserDrawerProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common');
  const { t: tSettings } = useTranslation('settings');
  const { systemColors, brandColors } = useTheme();
  const { isAuthenticated, signOut } = useAuth();
  const profileQuery = useProfile({ enabled: isAuthenticated });
  const profile = profileQuery.data;
  const segments = useSegments();
  const insets = useSafeAreaInsets();
  const windowDimensions = useWindowDimensions();
  const drawerWidth = Math.min(DRAWER_MAX_WIDTH, windowDimensions.width * DRAWER_SCREEN_FRACTION);
  const drawerProgress = useSharedValue(0);
  const [drawerMounted, setDrawerMounted] = useState(false);
  const feedbackSheetRef = useRef<BottomSheetModal>(null);
  const [feedbackMode, setFeedbackMode] = useState<FeedbackSheetMode>('rating');
  const [feedbackOpenNonce, setFeedbackOpenNonce] = useState(0);

  const profileDisplayName = profile?.displayName ?? profile?.email ?? t('header.you');
  const profileEmail = profile?.email ?? null;

  const openUserDrawer = useCallback(() => {
    setDrawerMounted(true);
  }, []);

  const closeUserDrawer = useCallback(() => {
    drawerProgress.value = withTiming(
      0,
      {
        duration: DRAWER_ANIMATION_MS,
        easing: Easing.out(Easing.cubic),
      },
      (finished) => {
        if (finished) runOnJS(setDrawerMounted)(false);
      },
    );
  }, [drawerProgress]);

  useEffect(() => {
    if (!drawerMounted) return;
    drawerProgress.value = withTiming(1, {
      duration: DRAWER_ANIMATION_MS,
      easing: Easing.out(Easing.cubic),
    });
  }, [drawerMounted, drawerProgress]);

  useEffect(() => {
    if (feedbackOpenNonce === 0) return;
    feedbackSheetRef.current?.present();
  }, [feedbackOpenNonce]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: drawerProgress.value,
  }));

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -drawerWidth + drawerWidth * drawerProgress.value }],
  }));

  const openBoards = useCallback(() => {
    closeUserDrawer();
    const returnTo = currentBoardReturnTo(segments);
    router.push({ pathname: '/boards', params: { returnTo } });
  }, [closeUserDrawer, segments]);

  // "My Boards" is now a management screen (edit / delete owned, unfollow
  // followed), distinct from the board picker that "Change Board" opens.
  const openManageBoards = useCallback(() => {
    closeUserDrawer();
    router.push('/boards/manage');
  }, [closeUserDrawer]);

  const openProfileSettings = useCallback(() => {
    closeUserDrawer();
    router.push('/(tabs)/profile/more');
  }, [closeUserDrawer]);

  const openEditProfile = useCallback(() => {
    closeUserDrawer();
    router.push('/(tabs)/profile/edit');
  }, [closeUserDrawer]);

  const openPlaylists = useCallback(() => {
    closeUserDrawer();
    router.push('/(tabs)/discover/all');
  }, [closeUserDrawer]);

  const openAbout = useCallback(() => {
    closeUserDrawer();
    router.push('/about');
  }, [closeUserDrawer]);

  const openFeedback = useCallback(
    (mode: FeedbackSheetMode) => {
      closeUserDrawer();
      setFeedbackMode(mode);
      setFeedbackOpenNonce((previousNonce) => previousNonce + 1);
    },
    [closeUserDrawer],
  );

  const openDiscord = useCallback(() => {
    closeUserDrawer();
    void openDiscordInvite('user-drawer');
  }, [closeUserDrawer]);

  const handleSignOut = useCallback(() => {
    closeUserDrawer();
    void signOut('manual').catch(reportError);
  }, [closeUserDrawer, signOut]);

  const contextValue = useMemo(() => ({ openUserDrawer, closeUserDrawer }), [openUserDrawer, closeUserDrawer]);

  return (
    <UserDrawerContext.Provider value={contextValue}>
      {children}
      <Modal visible={drawerMounted} transparent animationType="none" onRequestClose={closeUserDrawer}>
        <View style={styles.modalRoot}>
          <Animated.View style={[styles.backdrop, { backgroundColor: overlays.scrim }, backdropStyle]}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={closeUserDrawer}
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
              {/* Tappable to edit only when signed in; otherwise a plain header.
                  Both branches render the same body, differing only in the
                  wrapper + chevron. */}
              {profile?.id ? (
                <Pressable
                  style={styles.profileHeader}
                  onPress={openEditProfile}
                  accessibilityRole="button"
                  accessibilityLabel={tSettings('profile.editAction')}
                >
                  <ProfileHeaderBody
                    avatarUrl={profile.avatarUrl}
                    displayName={profileDisplayName}
                    email={profileEmail}
                  />
                  <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
                </Pressable>
              ) : (
                <View style={styles.profileHeader}>
                  <ProfileHeaderBody
                    avatarUrl={profile?.avatarUrl}
                    displayName={profileDisplayName}
                    email={profileEmail}
                  />
                </View>
              )}

              <View style={[styles.menuGroup, { backgroundColor: systemColors.elevatedSurface }]}>
                <DrawerRow icon="boards" title={t('userDrawer.changeBoard')} onPress={openBoards} />
                <DrawerRow icon="boards.fill" title={t('myBoards.title')} onPress={openManageBoards} />
              </View>

              <View style={[styles.menuGroup, { backgroundColor: systemColors.elevatedSurface }]}>
                <DrawerRow icon="settings" title={t('ariaLabels.settings')} onPress={openProfileSettings} />
                <DrawerRow icon="playlist" title={t('userDrawer.myPlaylists')} onPress={openPlaylists} />
                <DrawerRow icon="info" title={t('userDrawer.about')} onPress={openAbout} showSeparator={false} />
              </View>

              <View style={[styles.menuGroup, { backgroundColor: systemColors.elevatedSurface }]}>
                <DrawerRow icon="star" title={t('userDrawer.rateBoardsesh')} onPress={() => openFeedback('rating')} />
                <DrawerRow icon="flag" title={t('userDrawer.reportBug')} onPress={() => openFeedback('bug')} />
                <DrawerRow
                  icon="open.external"
                  title={t('userDrawer.joinDiscord')}
                  tintColor={brandColors.primary}
                  onPress={openDiscord}
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
          </Animated.View>
        </View>
      </Modal>
      <FeedbackSheet sheetRef={feedbackSheetRef} mode={feedbackMode} />
    </UserDrawerContext.Provider>
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
  modalRoot: {
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
